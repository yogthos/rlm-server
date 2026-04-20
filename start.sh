#!/bin/bash
# DEBUG=* shows every category. Set DEBUG=rlm,tree,io for a quieter stream.
TMPDIR=/tmp \
  RLM_MODEL_PATH=models/Qwen3.6-35B-A3B-Q8_0.gguf \
  RLM_MAX_DECOMPOSE_DEPTH=8 \
  RLM_SANDBOX_TIMEOUT=7200000 \
  RLM_MAX_TOKENS=8192 \
  RLM_TIMEOUT_MS=600000 \
  RLM_PORT=3001 \
  DEBUG=${DEBUG:-rlm,tree,io,server,queue,progress,plan,build,dispatch,finalize,testrun,load,bridge,finalfiles,plan-integration,integration-tests,integration-review,integration-loop,attribution,coherence,cleanup,project-tests,leaf-up-build} \
  npm start > log.txt 2>&1
