param([string]$SourcePath,[string]$DestinationPath)
$ErrorActionPreference = 'Stop'
if ([System.IO.Directory]::Exists($SourcePath)) {
    [System.IO.Directory]::Move($SourcePath,$DestinationPath)
} else {
    [System.IO.File]::Move($SourcePath,$DestinationPath)
}
