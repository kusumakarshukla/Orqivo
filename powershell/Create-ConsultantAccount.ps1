<#
.SYNOPSIS
Creates a consultant or vendor account inside the configured demo OU.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$FirstName,
    [Parameter(Mandatory = $true)][string]$LastName,
    [string]$MiddleName = '',
    [Parameter(Mandatory = $true)][string]$LineManagerSam,
    [Parameter(Mandatory = $true)][string]$DateOfJoining,
    [Parameter(Mandatory = $true)][string]$TicketNumber,
    [Parameter(Mandatory = $true)][string]$Office,
    [Parameter(Mandatory = $true)][string]$JobTitle,
    [Parameter(Mandatory = $true)][string]$Department,
    [Parameter(Mandatory = $true)][string]$Mobile,
    [string]$StaffId = '',
    [Parameter(Mandatory = $true)][string]$LastWorkingDay,
    [Parameter(Mandatory = $true)]
    [ValidateSet('Consultant', 'Vendor')]
    [string]$AccountType,
    [Parameter(Mandatory = $true)][string]$ParentCompany,
    [Parameter(Mandatory = $true)][string]$Subcompany
)

$ErrorActionPreference = 'Stop'
$demoOuDn = $env:ORQIVO_AD_DEMO_OU_DN

if ([string]::IsNullOrWhiteSpace($demoOuDn)) {
    throw 'The configured demo OU is required.'
}
if ($LineManagerSam -notmatch '^[A-Za-z0-9._$-]{1,20}$') {
    throw 'The line manager SamAccountName is invalid.'
}

$joiningDate = [datetime]::MinValue
$lastDay = [datetime]::MinValue
if (-not [datetime]::TryParseExact(
    $DateOfJoining,
    'yyyy-MM-dd',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::None,
    [ref]$joiningDate
)) {
    throw 'DateOfJoining must use yyyy-MM-dd format.'
}
if (-not [datetime]::TryParseExact(
    $LastWorkingDay,
    'yyyy-MM-dd',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::None,
    [ref]$lastDay
)) {
    throw 'LastWorkingDay must use yyyy-MM-dd format.'
}
if ($lastDay.Date -lt $joiningDate.Date) {
    throw 'A consultant or vendor last working day cannot precede its joining date.'
}

Import-Module ActiveDirectory -ErrorAction Stop
Get-ADOrganizationalUnit -Identity $demoOuDn -ErrorAction Stop | Out-Null

$baseSam = (($FirstName + '.' + $LastName) -replace '[^A-Za-z0-9._-]', '').Trim('.')
if ([string]::IsNullOrWhiteSpace($baseSam)) {
    throw 'The supplied name cannot produce a valid SamAccountName.'
}
$baseSam = $baseSam.Substring(0, [Math]::Min(20, $baseSam.Length))
$samAccountName = $baseSam
$suffix = 1
while (Get-ADUser -Filter "SamAccountName -eq '$samAccountName'" -ErrorAction Stop) {
    $suffixText = $suffix.ToString([Globalization.CultureInfo]::InvariantCulture)
    $prefixLength = 20 - $suffixText.Length
    if ($prefixLength -lt 1) {
        throw 'Could not generate an unused demo SamAccountName.'
    }
    $samAccountName = $baseSam.Substring(0, [Math]::Min($prefixLength, $baseSam.Length)) + $suffixText
    $suffix++
    if ($suffix -gt 1000) {
        throw 'Could not generate an unused demo SamAccountName.'
    }
}

Write-Host "Preparing $AccountType account '$samAccountName'"
$manager = Get-ADUser -Identity $LineManagerSam -ErrorAction Stop
$randomBytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($randomBytes)
} finally {
    $rng.Dispose()
}
$initialPassword = [Convert]::ToBase64String($randomBytes) + 'aA1!'
$fullName = (@($FirstName, $MiddleName, $LastName) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ' '
$newUser = @{
    Name = $fullName
    DisplayName = $fullName
    GivenName = $FirstName
    Surname = $LastName
    SamAccountName = $samAccountName
    UserPrincipalName = "$samAccountName@$((Get-ADDomain -ErrorAction Stop).DNSRoot)"
    Path = $demoOuDn
    Enabled = $true
    AccountPassword = ConvertTo-SecureString $initialPassword -AsPlainText -Force
    ChangePasswordAtLogon = $true
    Manager = $manager.DistinguishedName
    Office = $Office
    Title = $JobTitle
    Department = $Department
    MobilePhone = $Mobile
    Company = $ParentCompany
    Division = $Subcompany
    Description = "$AccountType account; ticket $TicketNumber; joining $($joiningDate.ToString('yyyy-MM-dd'))"
}
if (-not [string]::IsNullOrWhiteSpace($MiddleName)) {
    $newUser['Initials'] = $MiddleName.Substring(0, 1)
}

Write-Host "Creating $AccountType account '$samAccountName'"
New-ADUser @newUser -ErrorAction Stop
Set-ADAccountExpiration -Identity $samAccountName -DateTime $lastDay -ErrorAction Stop

$created = Get-ADUser -Identity $samAccountName -Properties DistinguishedName, Enabled -ErrorAction Stop
if (-not $created.Enabled) {
    throw 'The created account is not enabled.'
}

$Ansible.Result = @{
    success = $true
    sam_account_name = $created.SamAccountName
    distinguished_name = $created.DistinguishedName
    enabled = $created.Enabled
    password_change_required = $true
}
Write-Host "User Created: '$($created.SamAccountName)'"
