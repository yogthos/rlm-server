#!/bin/bash
RLM_MODEL=deepseek-chat \
    RLM_SANDBOX_TIMEOUT=7200000 \
    RLM_MAX_TOKENS=8192 \
    RLM_PORT=3001 \
    DEBUG=${DEBUG:-rlm,tree,io,server,queue,progress,plan,build,dispatch,finalize,testrun,load,bridge,finalfiles} \
    npm start > log.txt 2>&1
