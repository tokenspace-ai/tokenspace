#!/bin/bash

echo "Symlinking tokenspace CLI $(pwd)/src/cli.ts -> /usr/local/bin/tokenspace"

sudo ln -s $(pwd)/src/cli.ts /usr/local/bin/tokenspace
