<#
.SYNOPSIS
Reads operating-system, uptime, CPU, memory, and service health.
.DESCRIPTION
Read-only health collection using CIM cmdlets.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

try {
    $computer = Get-CimInstance -ClassName Win32_ComputerSystem
    $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem
    $processors = Get-CimInstance -ClassName Win32_Processor
    $lastBoot = $operatingSystem.LastBootUpTime
    $totalMemory = [double]$computer.TotalPhysicalMemory
    $freeMemory = [double]$operatingSystem.FreePhysicalMemory * 1KB
    $importantServices = @('Spooler', 'W32Time', 'Dnscache', 'LanmanServer')
    $serviceHealth = foreach ($name in $importantServices) {
        $service = Get-Service -Name $name -ErrorAction SilentlyContinue
        [ordered]@{
            name = $name
            status = if ($null -eq $service) { 'NotInstalled' } else { $service.Status.ToString() }
        }
    }

    [ordered]@{
        success = $true
        hostname = $env:COMPUTERNAME
        operating_system = $operatingSystem.Caption
        uptime_hours = [math]::Round(((Get-Date) - $lastBoot).TotalHours, 1)
        cpu_percent = [math]::Round((($processors | Measure-Object -Property LoadPercentage -Average).Average), 1)
        memory_percent = if ($totalMemory -gt 0) {
            [math]::Round((1 - ($freeMemory / $totalMemory)) * 100, 1)
        } else { 0 }
        services = @($serviceHealth)
    } | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
catch {
    [ordered]@{
        success = $false
        error = 'Server health collection failed. Check CIM permissions and Windows event logs.'
    } | ConvertTo-Json -Depth 4 -Compress
    exit 1
}
