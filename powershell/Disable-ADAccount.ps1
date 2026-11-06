<#
.SYNOPSIS
Disables an account only when it is inside the configured demo OU.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._$-]{1,20}$')]
    [string]$SamAccountName
)

$ErrorActionPreference = 'Stop'


if ([string]::IsNullOrWhiteSpace($demoOuDn)) {
    throw 'The configured demo OU is required.'
}

Import-Module ActiveDirectory -ErrorAction Stop


Write-Host "Finding user '$SamAccountName'"
$user = Get-ADUser `
    -Filter "SamAccountName -eq '$SamAccountName'" `
    -SearchScope Subtree `
    -Properties Enabled `
    -ErrorAction Stop

if (-not $user) {
    throw 'The requested account was not found inside the configured demo OU.'
}

Write-Host "Fetched user '$($user.SamAccountName)'"
if ($user.Enabled) {
    Write-Host "Disabling user '$($user.SamAccountName)'"
    Disable-ADAccount -Identity $user -Confirm:$false -ErrorAction Stop
    $Ansible.Changed = $true
}

$verifiedUser = Get-ADUser `
    -Identity $user.DistinguishedName `
    -Properties Enabled `
    -ErrorAction Stop
if ($verifiedUser.Enabled) {
    throw 'The account is still enabled after the disable operation.'
}

$Ansible.Result = @{
    success = $true
    sam_account_name = $verifiedUser.SamAccountName
    enabled = $verifiedUser.Enabled
}
Write-Host "User Disabled: '$($verifiedUser.SamAccountName)'"
