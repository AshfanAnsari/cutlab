/**
 * rider-harness.entry.ts — UI redesign W1 rider check: the prompt-edit
 * revised-project parser accepts BOTH the bare project and the legacy
 * envelope { project, summary, lane }, and both parse to the same project.
 * Bundled with `vite build --ssr` and run under Node, like the other
 * harness entries.
 */
import { parseRevisedProject } from '../src/services/revisedProject';
import { emptyProject } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}`); }
}

const project = emptyProject();
project.name = 'Rider fixture';
project.canvas = { w: 720, h: 1280, fps: 30 };
const bare = JSON.stringify(project);
const envelope = JSON.stringify({ project, summary: 'made it louder', lane: 'freellmapi' });

const fromBare = parseRevisedProject(bare);
const fromEnvelope = parseRevisedProject(envelope);
check('bare project parses', fromBare.name === 'Rider fixture');
check('envelope parses to the project', fromEnvelope.name === 'Rider fixture');
check('both shapes parse identically', JSON.stringify(fromBare) === JSON.stringify(fromEnvelope));
check('envelope summary does not leak into the project',
  (fromEnvelope as unknown as { summary?: string }).summary === undefined);

console.log(failures === 0 ? 'rider-harness: ALL PASS' : `rider-harness: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
