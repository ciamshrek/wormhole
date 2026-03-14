#!/bin/sh
set -e

echo "--- repos ---"
gh repo list --limit 5

echo ""
echo "--- starred ---"
gh api user/starred --jq '.[:3] | .[].full_name'
