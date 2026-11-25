// SECURECASEDESK_DETAINEES_V22_S3A
// Thin session-aware wrappers over the detainees core (not used by the screen until section 3b).
import { getDb } from '../database/db';
import { requirePerm } from '../security/guard';
import type { Session } from '../security/guard';
import * as core from '../modules/detainees/detainees-core';
import * as Crypto from 'expo-crypto';

const ctx: core.Ctx = { newId: () => Crypto.randomUUID() };

async function coreDb(): Promise<core.CoreDb> {
  return (await getDb()) as unknown as core.CoreDb;
}

export async function createDetention(session: Session | null | undefined, input: core.CreateDetentionInput) {
  const s = requirePerm(session, 'detainees.manage');
  return core.createDetention(await coreDb(), String(s.userId), input, ctx);
}

export async function getPersonWithPeriods(session: Session | null | undefined, personId: string) {
  const s = requirePerm(session, 'detainees.view');
  return core.getPersonWithPeriods(await coreDb(), String(s.userId), personId);
}

export async function searchDetainees(session: Session | null | undefined, query: string) {
  const s = requirePerm(session, 'detainees.view');
  return core.searchDetainees(await coreDb(), String(s.userId), query);
}

export async function updatePerson(session: Session | null | undefined, personId: string, patch: core.PersonPatch) {
  const s = requirePerm(session, 'detainees.manage');
  return core.updatePerson(await coreDb(), String(s.userId), personId, patch, ctx);
}

export async function updatePeriod(session: Session | null | undefined, detaineeId: string, patch: core.PeriodPatch) {
  const s = requirePerm(session, 'detainees.manage');
  return core.updatePeriod(await coreDb(), String(s.userId), detaineeId, patch, ctx);
}

export async function correctPeriodField(session: Session | null | undefined, input: core.CorrectionInput) {
  const s = requirePerm(session, 'detainees.correct');
  return core.correctPeriodField(await coreDb(), String(s.userId), input, ctx);
}

export async function releasePeriod(session: Session | null | undefined, input: core.ReleaseInput) {
  const s = requirePerm(session, 'detainees.manage');
  return core.releasePeriod(await coreDb(), String(s.userId), input, ctx);
}

export async function transferPeriod(session: Session | null | undefined, input: core.TransferInput) {
  const s = requirePerm(session, 'detainees.manage');
  return core.transferPeriod(await coreDb(), String(s.userId), input, ctx);
}
