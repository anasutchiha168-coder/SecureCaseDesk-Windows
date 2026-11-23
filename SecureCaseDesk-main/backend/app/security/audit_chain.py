"""منطق استقبال سلسلة التدقيق من الأجهزة (SECURECASEDESK_PHASE8_S3).

الخادم لا يملك مفتاح HMAC (يبقى في SecureStore على الجهاز)، لذلك يتحقق من:
الشكل، والتسلسل، وربط previous_hash، وعدم تكرار operation_id بمحتوى مختلف.
ولا يكتب فوق أي سجل: التعارض يُرفض ويُبلَّغ به.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Protocol

GENESIS_HASH = "GENESIS"
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
REQUIRED = (
    "sequence_no", "operation_id", "source_event_id", "operation_type",
    "entity_type", "created_at", "previous_hash", "record_hash", "hmac_version",
)


class AuditStore(Protocol):
    def get_state(self, device_id: str) -> Dict[str, Any]: ...
    def get_event(self, device_id: str, operation_id: str) -> Optional[Dict[str, Any]]: ...
    def append(self, device_id: str, event: Dict[str, Any]) -> None: ...


class InMemoryAuditStore:
    """للاختبارات فقط. التنفيذ الإنتاجي على PostgreSQL ضمن المرحلة 10."""

    def __init__(self) -> None:
        self.events: Dict[str, List[Dict[str, Any]]] = {}
        self.idempotency: Dict[str, Dict[str, Any]] = {}
        self.denied: List[Dict[str, Any]] = []

    def get_state(self, device_id: str) -> Dict[str, Any]:
        items = self.events.get(device_id, [])
        if not items:
            return {"last_sequence": 0, "last_hash": GENESIS_HASH}
        last = items[-1]
        return {"last_sequence": last["sequence_no"], "last_hash": last["record_hash"]}

    def get_event(self, device_id: str, operation_id: str) -> Optional[Dict[str, Any]]:
        for e in self.events.get(device_id, []):
            if e["operation_id"] == operation_id:
                return e
        return None

    def append(self, device_id: str, event: Dict[str, Any]) -> None:
        self.events.setdefault(device_id, []).append(dict(event))

    def record_denied(self, principal: str, path: str, reason: str) -> None:
        self.denied.append({"principal": principal, "path": path, "reason": reason})


def _shape_error(event: Dict[str, Any]) -> Optional[str]:
    for field in REQUIRED:
        if event.get(field) is None:
            return "MISSING_" + field.upper()
    if not isinstance(event["sequence_no"], int) or event["sequence_no"] < 1:
        return "BAD_SEQUENCE"
    if not _HEX64.match(str(event["record_hash"])):
        return "BAD_RECORD_HASH"
    prev = str(event["previous_hash"])
    if prev != GENESIS_HASH and not _HEX64.match(prev):
        return "BAD_PREVIOUS_HASH"
    return None


def ingest_batch(store: AuditStore, device_id: str, events: List[Dict[str, Any]]) -> Dict[str, Any]:
    """يعالج الأحداث بالترتيب ويتوقف عند أول تعارض أو رفض."""
    receipt: Dict[str, Any] = {"accepted": [], "duplicates": [], "conflicts": [], "rejected": []}
    for event in sorted(events, key=lambda e: e.get("sequence_no") or 0):
        seq = event.get("sequence_no") or 0
        problem = _shape_error(event)
        if problem:
            receipt["rejected"].append({"sequence_no": seq, "reason": problem})
            break

        existing = store.get_event(device_id, event["operation_id"])
        if existing is not None:
            if existing["record_hash"] == event["record_hash"]:
                receipt["duplicates"].append(seq)
                continue
            receipt["conflicts"].append({"sequence_no": seq, "reason": "OPERATION_ID_REUSED"})
            break

        state = store.get_state(device_id)
        if seq <= state["last_sequence"]:
            receipt["conflicts"].append({"sequence_no": seq, "reason": "SEQUENCE_FORK"})
            break
        if seq != state["last_sequence"] + 1:
            receipt["conflicts"].append({"sequence_no": seq, "reason": "SEQUENCE_GAP"})
            break
        if event["previous_hash"] != state["last_hash"]:
            receipt["conflicts"].append({"sequence_no": seq, "reason": "BROKEN_LINK"})
            break

        store.append(device_id, event)
        receipt["accepted"].append(seq)
    return receipt
