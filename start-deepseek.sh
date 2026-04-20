#!/bin/bash
TMPDIR=/tmp \
    RLM_MODEL=deepseek-chat \
    RLM_SANDBOX_TIMEOUT=7200000 \
    RLM_MAX_TOKENS=8192 \
    RLM_TIMEOUT_MS=600000 \
    RLM_PORT=3001 \
    DEBUG=${DEBUG:-rlm,tree,io,server,queue,progress,plan,build,dispatch,finalize,testrun,load,bridge,finalfiles,plan-integration,integration-tests,integration-review,integration-loop,attribution,coherence,cleanup,project-tests,three-pass,leaf-up-build} \
    npm start > log.txt 2>&1
