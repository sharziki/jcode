#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
test_home=$(mktemp -d)
trap 'rm -rf "$test_home"' EXIT
mkdir -p "$test_home/builds/current"
cat > "$test_home/builds/current/jcode" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$JCODE_HOME" "$@"
STUB
chmod +x "$test_home/builds/current/jcode"
result=$(JCODE_HOME="$test_home" "$repo/scripts/jcode-local-launcher.sh")
[[ "$result" == "$test_home"$'\n--resume\nsession_t-rex_1791077425325_df475c475c9ace0e\n--no-update' ]]
result=$(JCODE_HOME="$test_home" "$repo/scripts/jcode-local-launcher.sh" run 'hello world')
[[ "$result" == "$test_home"$'\nrun\nhello world' ]]
echo 'local launcher: persistent coordinator and explicit arguments passed'
