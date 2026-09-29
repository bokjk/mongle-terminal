import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { HostState } from '../../packages/protocol/index';

const manifestSchema = z.object({
  version: z.literal(1), hostId: z.string().uuid(), bootId: z.string().uuid(),
  terminals: z.array(z.object({ id: z.string().uuid(), generation: z.string().uuid() }).strict()).max(32),
}).strict();

/** A one-shot compatibility hint for old hosts, not a command replay record. */
export async function writeResumeManifest(dataDir: string, state: HostState): Promise<void> {
  const manifest = manifestSchema.parse({
    version: 1, hostId: state.hostId, bootId: state.bootId,
    terminals: state.terminals.filter(terminal => terminal.status === 'running').map(({ id, generation }) => ({ id, generation })),
  });
  const target = path.join(path.resolve(dataDir), 'workspace-resume.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(manifest), 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}
