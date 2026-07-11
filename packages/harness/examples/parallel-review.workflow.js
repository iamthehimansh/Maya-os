/**
 * Example mayac workflow — fan out a review across files, then synthesize.
 *
 * Run it:   mayac --workflow examples/parallel-review.workflow.js
 *
 * The script body runs in an async context with these injected:
 *   agent(prompt)              → Promise<string>   spawn one sub-agent, get its answer
 *   parallel([() => …, …])     → Promise<any[]>    run thunks concurrently
 *   pipeline(items, ...stages) → Promise<any[]>    each item flows through all stages
 *   log(msg)                   → void              progress line
 *   args                       → any               value passed by the caller
 *
 * The final `return` value is printed by the CLI.
 */

const files = (Array.isArray(args) && args.length ? args : ['src/loop/index.ts', 'src/cli.ts']);

log(`reviewing ${files.length} files in parallel…`);

// One sub-agent per file, all at once.
const reviews = await parallel(
  files.map((f) => () => agent(`Read ${f} and list its top 3 correctness risks, terse bullets.`)),
);

log('synthesizing…');

// A final sub-agent folds the per-file reviews into one summary.
const summary = await agent(
  `Combine these per-file reviews into a single prioritized list of the 5 most important issues:\n\n` +
    files.map((f, i) => `## ${f}\n${reviews[i]}`).join('\n\n'),
);

return summary;
