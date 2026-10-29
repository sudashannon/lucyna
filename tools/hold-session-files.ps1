$ErrorActionPreference = 'Stop'
$held = [System.Collections.Generic.List[System.IO.FileStream]]::new()
try {
    $request = [Console]::ReadLine() | ConvertFrom-Json
    foreach ($file in $request.files) {
        if ([System.IO.File]::Exists($file)) {
            # Reject existing/new write handles while allowing the owning desktop
            # to rename the file into its recycle bin. No contents are modified.
            $stream = [System.IO.FileStream]::new($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete))
            $held.Add($stream)
        }
    }
    [Console]::WriteLine('{"ready":true}')
    [Console]::In.ReadToEnd() | Out-Null
} catch {
    [Console]::WriteLine('{"error":"Windows session files are in use. Close this session before deleting; files are preserved."}')
    exit 1
} finally {
    foreach ($stream in $held) { $stream.Dispose() }
}
