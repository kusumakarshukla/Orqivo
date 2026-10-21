<#
.SYNOPSIS
Restarts or starts one service from the approved service allowlist.
.DESCRIPTION
Returns a compact JSON result and never evaluates user-provided commands.
.PARAMETER ServiceName
Approved service name.
.PARAMETER ChangeNumber
Change or incident reference.
.PARAMETER BusinessReason
Reason for the operation.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Spooler', 'W32Time', 'Dnscache', 'LanmanServer')]
    [string]$ServiceName,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z][A-Za-z0-9_-]{1,31}$')]
    [string]$ChangeNumber,
    [Parameter(Mandatory = $true)]
    [ValidateLength(3, 1000)]
    [string]$BusinessReason
)

$ErrorActionPreference = 'Stop'

try {
    $service = Get-Service -Name $ServiceName -ErrorAction Stop
    $before = $service.Status.ToString()

    if ($service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running) {
        Restart-Service -Name $ServiceName -Force -ErrorAction Stop
    }
    else {
        Start-Service -Name $ServiceName -ErrorAction Stop
    }

    $service = Get-Service -Name $ServiceName -ErrorAction Stop
    $service.WaitForStatus(
        [System.ServiceProcess.ServiceControllerStatus]::Running,
        [TimeSpan]::FromSeconds(60)
    )
    $service.Refresh()

    [ordered]@{
        success = $true
        service = $ServiceName
        before = $before
        after = $service.Status.ToString()
        change_number = $ChangeNumber
        result = 'Service is running.'
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}
catch {
    [ordered]@{
        success = $false
        service = $ServiceName
        error = 'The service operation failed. Check the Windows event log and service permissions.'
    } | ConvertTo-Json -Depth 4 -Compress
    exit 1
}
