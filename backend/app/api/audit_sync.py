"""واجهة مزامنة سجل التدقيق (SECURECASEDESK_PHASE8_S3).

تفشل مغلقة: حتى تُربط المصادقة الحقيقية في المرحلة 10 تُرجع الواجهة 501
ولا تقبل أي طلب. لا تُستخدم أي بيانات اعتماد افتراضية.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from app.security.audit_chain import ingest_batch

router = APIRouter(prefix="/api/v1/audit", tags=["audit"])


class Principal(BaseModel):
    user_id: str
    role: str
    active: bool = True


class BatchIn(BaseModel):
    device_id: str
    events: List[Dict[str, Any]]


def get_principal() -> Principal:  # يُستبدل بالمصادقة الفعلية في المرحلة 10
    raise HTTPException(status_code=501, detail={"code": "AUTH_NOT_CONFIGURED"})


def get_store():  # يُستبدل بمخزن PostgreSQL في المرحلة 10
    raise HTTPException(status_code=501, detail={"code": "STORE_NOT_CONFIGURED"})


def _deny(store: Any, principal: Optional[Principal], path: str, code: str, status: int):
    recorder = getattr(store, "record_denied", None)
    if recorder:
        recorder(principal.user_id if principal else "-", path, code)
    raise HTTPException(status_code=status, detail={"code": code})


@router.post("/events/batch")
def ingest(
    batch: BatchIn,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    principal: Principal = Depends(get_principal),
    store: Any = Depends(get_store),
):
    if not principal.active:
        _deny(store, principal, "/events/batch", "ACCOUNT_DISABLED", 403)
    if len(batch.events) > 200:
        raise HTTPException(status_code=413, detail={"code": "BATCH_TOO_LARGE"})

    cache = getattr(store, "idempotency", None)
    if cache is not None and idempotency_key in cache:
        cached = cache[idempotency_key]
        return _respond(cached)

    receipt = ingest_batch(store, batch.device_id, batch.events)
    if cache is not None:
        cache[idempotency_key] = receipt
    return _respond(receipt)


def _respond(receipt: Dict[str, Any]):
    from fastapi.responses import JSONResponse

    bad = bool(receipt["conflicts"] or receipt["rejected"])
    return JSONResponse(status_code=409 if bad else 200, content=receipt)


@router.get("/report")
def report(principal: Principal = Depends(get_principal), store: Any = Depends(get_store)):
    if not principal.active or principal.role != "admin":
        _deny(store, principal, "/report", "FORBIDDEN", 403)
    devices = getattr(store, "events", {})
    return {
        "devices": [
            {"device_id": d, "events": len(items),
             "last_sequence": items[-1]["sequence_no"] if items else 0}
            for d, items in devices.items()
        ]
    }
