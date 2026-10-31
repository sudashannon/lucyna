# Each non-comment line is a complete POSIX statement; the desktop joins them.
set -eu;
umask 077;
fail() { printf 'LUCYNA_HOST_V1 {"ok":false,"code":"%s"}\n' "$1"; exit 0; };
expected_hash=$1; expected_release=$2; expected_bytes=$3; install_mode=$4; install_prefix=$5;
case "$HOME" in /*) ;; *) fail invalid_home ;; esac;
test -d "$HOME" && test ! -L "$HOME" || fail invalid_home;
test "$(stat -c %u "$HOME")" = "$(id -u)" || fail invalid_home_owner;
work=$(mktemp -d "$HOME/.lucyna-bootstrap.XXXXXXXX") || fail staging_failed;
trap 'rm -rf -- "$work"' EXIT; trap 'exit 1' HUP INT TERM;
head -c "$((expected_bytes + 1))" > "$work/package.tgz";
test "$(stat -c %s "$work/package.tgz")" = "$expected_bytes" || fail upload_incomplete;
printf '%s  %s\n' "$expected_hash" "$work/package.tgz" | sha256sum -c - >/dev/null 2>&1 || fail archive_digest_mismatch;
mkdir "$work/payload";
tar -xzf "$work/package.tgz" -C "$work/payload" --no-same-owner --no-same-permissions || fail unpack_failed;
"$work/payload/lucyna-host" install --source "$work/payload" --expected-release "$expected_release" --install-mode "$install_mode" --prefix "$install_prefix";
