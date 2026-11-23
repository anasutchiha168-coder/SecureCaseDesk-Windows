import unittest

from app.security.audit_chain import GENESIS_HASH, InMemoryAuditStore, ingest_batch


def make(seq, prev, h=None):
    return {
        "sequence_no": seq, "operation_id": "op-%d" % seq, "source_event_id": "src-%d" % seq,
        "operation_type": "create", "entity_type": "cases", "created_at": 1000 + seq,
        "previous_hash": prev, "record_hash": h or ("%064x" % seq), "hmac_version": "HMAC-SHA256-v1",
    }


def chain(n):
    out, prev = [], GENESIS_HASH
    for i in range(1, n + 1):
        e = make(i, prev)
        out.append(e)
        prev = e["record_hash"]
    return out


class AuditChainTests(unittest.TestCase):
    def test_accepts_valid_chain_and_is_idempotent(self):
        s, c = InMemoryAuditStore(), chain(3)
        r1 = ingest_batch(s, "d1", c)
        r2 = ingest_batch(s, "d1", c)
        self.assertEqual(r1["accepted"], [1, 2, 3])
        self.assertEqual(r2["duplicates"], [1, 2, 3])
        self.assertEqual(len(s.events["d1"]), 3)

    def test_gap_is_conflict(self):
        s, c = InMemoryAuditStore(), chain(3)
        r = ingest_batch(s, "d1", [c[0], c[2]])
        self.assertEqual(r["accepted"], [1])
        self.assertEqual(r["conflicts"][0]["reason"], "SEQUENCE_GAP")

    def test_broken_link_is_conflict_and_stops(self):
        s, c = InMemoryAuditStore(), chain(3)
        c[1]["previous_hash"] = "%064x" % 999
        r = ingest_batch(s, "d1", c)
        self.assertEqual(r["accepted"], [1])
        self.assertEqual(r["conflicts"][0]["reason"], "BROKEN_LINK")
        self.assertEqual(len(s.events["d1"]), 1)

    def test_fork_and_reused_operation_id_never_overwrite(self):
        s, c = InMemoryAuditStore(), chain(2)
        ingest_batch(s, "d1", c)
        forged = dict(c[0], record_hash="%064x" % 12345)
        r = ingest_batch(s, "d1", [forged])
        self.assertEqual(r["conflicts"][0]["reason"], "OPERATION_ID_REUSED")
        self.assertEqual(s.events["d1"][0]["record_hash"], c[0]["record_hash"])

    def test_bad_shape_rejected(self):
        s = InMemoryAuditStore()
        bad = make(1, GENESIS_HASH)
        bad["record_hash"] = "zzz"
        r = ingest_batch(s, "d1", [bad])
        self.assertEqual(r["rejected"][0]["reason"], "BAD_RECORD_HASH")
        self.assertEqual(s.events, {})

    def test_devices_are_isolated(self):
        s, c = InMemoryAuditStore(), chain(2)
        ingest_batch(s, "d1", c)
        r = ingest_batch(s, "d2", c)
        self.assertEqual(r["accepted"], [1, 2])


if __name__ == "__main__":
    unittest.main()
