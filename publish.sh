#!/bin/bash

npm login && npm version patch && npm run build && npm run test:run && npm publish
