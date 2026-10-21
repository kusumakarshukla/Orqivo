<#
.SYNOPSIS
Reads total, used, free, and free-percent metrics for selected drives.
.DESCRIPTION
Read-only disk collection. Drive names are validated before querying.
.PARAMETER DriveLetters
One or more drive letters without a colon.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$DriveLetters
)

$ErrorActionPreference = 'Stop'

try {
    $results = foreach ($letter in $DriveLetters) {
        if ($letter -notmatch '^[A-Za-z]$') {
            throw 'Drive letter is invalid.'
        }
        $drive = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$($letter.ToUpper()):'"
        if ($null -eq $drive -or $drive.Size -le 0) {
            throw 'Drive was not found or is unavailable.'
        }
        $freeBytes = [double]$drive.FreeSpace
        $totalBytes = [double]$drive.Size
        [ordered]@{
            drive = "$($letter.ToUpper()):"
            total_gb = [math]::Round($totalBytes / 1GB, 2)
            used_gb = [math]::Round(($totalBytes - $freeBytes) / 1GB, 2)
            free_gb = [math]::Round($freeBytes / 1GB, 2)
            free_percent = [math]::Round(($freeBytes / $totalBytes) * 100, 1)
        }
    }

    [ordered]@{ success = $true; drives = @($results) } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}
catch {
    [ordered]@{
        success = $false
        error = 'Disk space collection failed. Verify the drive letter and read permissions.'
    } | ConvertTo-Json -Depth 4 -Compress
    exit 1
}
