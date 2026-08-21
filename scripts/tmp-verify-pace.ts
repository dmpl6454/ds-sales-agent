/**
 * Measure the NEW send period end to end: autopilot ON (audited), watch several sends,
 * report the gaps against the 107s baseline, restore the switch in a `finally`.
 */
import { prisma } from '@/lib/db';
import { setSetting, getSettings, SETTING_KEYS } from '@/lib/settings';
import { LAST_SEND_STARTED_KEY } from '@/outreach/dispatcher';

const WANT = 5;
const DEADLINE_MS = 13 * 60_000;
const stamp = (d = new Date()) => d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });

async function audit(detail: string) {
  await prisma.auditLog.create({
    data: { actor: 'cli:Tabish', action: 'autopilot.set', entity: 'Setting:autopilotEnabled', detail },
  });
}

async function main() {
  const was = (await getSettings()).autopilotEnabled;
  console.log(`${stamp()}  autopilot was ${was ? 'ON' : 'OFF'} · baseline period p50 was 107s (33.6/hour)`);

  const seen = new Set(
    (await prisma.outreachAttempt.findMany({ where: { status: { in: ['SENT', 'REPLIED'] } }, select: { id: true } })).map((a) => a.id),
  );

  if (!was) {
    await setSetting(SETTING_KEYS.autopilotEnabled, 'true');
    await audit('ON (measuring the send period after the gap fix)');
    console.log(`${stamp()}  AUTOPILOT ON (audited) — watching ${WANT} sends`);
  }

  const times: Date[] = [];
  const started = Date.now();
  try {
    while (times.length < WANT && Date.now() - started < DEADLINE_MS) {
      await new Promise((r) => setTimeout(r, 10_000));
      const fresh = await prisma.outreachAttempt.findMany({
        where: { status: { in: ['SENT', 'REPLIED'] }, id: { notIn: [...seen] } },
        orderBy: { sentAt: 'asc' },
        include: { sender: { select: { handle: true } }, target: { select: { handle: true, isVerified: true, role: true } } },
      });
      for (const a of fresh) {
        seen.add(a.id);
        const gap = times.length ? (a.sentAt!.getTime() - times[times.length - 1]!.getTime()) / 1000 : null;
        times.push(a.sentAt!);
        console.log(
          `${stamp(a.sentAt!)}  #${times.length} @${a.sender.handle} → @${a.target.handle}` +
            `  verified=${a.target.isVerified} role=${a.target.role}` +
            (gap !== null ? `  gap ${gap.toFixed(1)}s` : '  (first)'),
        );
      }
    }
  } finally {
    if (!was) {
      await setSetting(SETTING_KEYS.autopilotEnabled, 'false');
      await audit('OFF (measurement finished)');
      console.log(`\n${stamp()}  AUTOPILOT RESTORED TO OFF`);
    }
  }

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i += 1) gaps.push((times[i]!.getTime() - times[i - 1]!.getTime()) / 1000);
  if (gaps.length) {
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    console.log(`\ngaps: ${gaps.map((g) => g.toFixed(0) + 's').join(', ')}`);
    console.log(`mean ${mean.toFixed(1)}s → ${(3600 / mean).toFixed(1)}/hour   (was 107s → 33.6/hour)`);
  } else {
    console.log('\nnot enough sends to measure a gap');
  }

  const row = await prisma.setting.findUnique({ where: { key: LAST_SEND_STARTED_KEY } });
  console.log(`${LAST_SEND_STARTED_KEY}: ${row?.value ?? '(not written — the fix is NOT live)'}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
