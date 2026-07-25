/**
 * Optional LLM adapter — OFF by default.
 *
 * The smart node is a PURE DATA LAYER: store / query / traverse / local-ONNX
 * embed / auth / admin all run with NO LLM and NO `claude` CLI on the host.
 *
 * Any feature that needs a generative model (free-text note→graph ingestion,
 * LLM-judged dedup link suggestions, LLM-driven perspective extraction) is
 * OPT-IN and operator-supplied:
 *
 *   LLM_INGEST_ENABLED=1            # master switch (default: off)
 *   LLM_CMD="claude -p --model {model} --output-format text"
 *                                   # the command to run; receives the prompt on
 *                                   # STDIN and must print the completion to STDOUT.
 *                                   # {model} is substituted with the requested model.
 *
 * When disabled (the default), any attempt to use an LLM-dependent op fails with
 * a clear, actionable error — it never silently spawns `claude` and never crashes
 * the process.
 */

import { execSync } from 'node:child_process';

export class LlmDisabledError extends Error {
  constructor(feature: string) {
    super(
      `${feature} requires an LLM, which is opt-in and disabled by default. ` +
        `To enable it: set LLM_INGEST_ENABLED=1 and LLM_CMD to an operator-supplied ` +
        `command that reads a prompt on STDIN and writes the completion to STDOUT ` +
        `(e.g. LLM_CMD="claude -p --model {model} --output-format text"). ` +
        `The host must have that command installed; the default build does not.`,
    );
    this.name = 'LlmDisabledError';
  }
}

/** True only when the operator has explicitly enabled and configured an LLM. */
export function isLlmEnabled(): boolean {
  const flag = (process.env.LLM_INGEST_ENABLED ?? '').trim().toLowerCase();
  const enabled = flag === '1' || flag === 'true' || flag === 'yes';
  const cmd = (process.env.LLM_CMD ?? '').trim();
  return enabled && cmd.length > 0;
}

/**
 * Run the operator-configured LLM command, sending `prompt` on STDIN and
 * returning STDOUT. Throws {@link LlmDisabledError} when the LLM is not enabled.
 *
 * `model` is substituted into the `{model}` placeholder in LLM_CMD (default
 * placeholder value: "sonnet"). No model/provider is hardcoded — the operator
 * fully controls the command.
 */
export function runLlm(
  prompt: string,
  opts: { feature: string; model?: string; timeoutMs?: number } = { feature: 'This operation' },
): string {
  if (!isLlmEnabled()) {
    throw new LlmDisabledError(opts.feature);
  }

  const template = (process.env.LLM_CMD ?? '').trim();
  const model = opts.model ?? 'sonnet';
  const cmd = template.includes('{model}')
    ? template.replace(/\{model\}/g, model)
    : template;

  return execSync(cmd, {
    input: prompt,
    encoding: 'utf-8',
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 1024 * 1024,
    shell: '/bin/sh',
  });
}
