#!/bin/bash
# Graph context hook — delegates to Python script
exec python3 "$(dirname "$0")/graph-context.py"
