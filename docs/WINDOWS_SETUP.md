# Windows Server setup

Review these steps with the Windows/security administrators before making production changes. Do not blindly run production commands.

## Enable remoting and inspect listeners

Run elevated PowerShell:

```powershell
Enable-PSRemoting -Force
Get-ChildItem WSMan:\localhost\Listener
winrm enumerate winrm/config/Listener
```

`Enable-PSRemoting` can enable HTTP remoting. Production access should use HTTPS only after certificates and firewall rules are reviewed.

## Create an HTTPS listener

Use a certificate from the organization's internal CA where possible. For a lab only, a self-signed certificate can be created and its issuing certificate must be trusted by the Linux host:

```powershell
$cert = New-SelfSignedCertificate `
  -DnsName $env:COMPUTERNAME `
  -CertStoreLocation Cert:\LocalMachine\My `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -NotAfter (Get-Date).AddYears(1)
$cert.Thumbprint
winrm create winrm/config/Listener?Address=*+Transport=HTTPS "@{Hostname=`"$env:COMPUTERNAME`";CertificateThumbprint=`"$($cert.Thumbprint)`"}"
Get-ChildItem WSMan:\localhost\Listener
```

Verify the thumbprint against the approved certificate record; do not disable certificate validation to work around a mismatch.

## Restrict the firewall

Replace the example address with the Linux automation server's fixed source IP and confirm the resulting rule with the network team:

```powershell
New-NetFirewallRule `
  -DisplayName "WinRM HTTPS from automation host" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5986 `
  -RemoteAddress "192.0.2.10" -Profile Domain
```

Test from the Linux automation host:

```powershell
Test-WSMan -ComputerName $env:COMPUTERNAME -UseSSL -Port 5986
```

## Install the approved scripts

```powershell
New-Item -ItemType Directory -Path C:\Automation -Force
Copy-Item .\powershell\Restart-WindowsService.ps1 C:\Automation\
Copy-Item .\powershell\Get-ServerHealth.ps1 C:\Automation\
Copy-Item .\powershell\Get-DiskSpace.ps1 C:\Automation\
```

Grant read/execute rights only to the approved automation identity and administrators:

```powershell
icacls C:\Automation /inheritance:r
icacls C:\Automation /grant:r "Administrators:(OI)(CI)F" "DOMAIN\automation-service:(OI)(CI)RX"
icacls C:\Automation
```

Test each script locally with safe development values:

```powershell
& C:\Automation\Get-ServerHealth.ps1
& C:\Automation\Get-DiskSpace.ps1 -DriveLetters C
& C:\Automation\Restart-WindowsService.ps1 -ServiceName Spooler -ChangeNumber CHG-12345 -BusinessReason "Approved maintenance test"
```

The service restart changes system state. Use a non-production Windows host for initial validation.

## Certificate and HTTP listener review

Confirm the leaf certificate SAN matches the registered hostname, it is in date, its chain is trusted on Linux, and its thumbprint matches the approved certificate. Remove an HTTP listener only after confirming no other approved application depends on it:

```powershell
winrm delete winrm/config/Listener?Address=*+Transport=HTTP
```
