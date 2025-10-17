<#
PowerShell wrapper to run SQL file against PostgreSQL using psql.
Usage (PowerShell):
  .\run_sql_ps.ps1 -Host staging.db.example.com -Port 5432 -User myuser -DbName mydb -SqlFile .\db_cleanup_create_indexes.sql

It will prompt for password if not provided as -Password (recommended to use secure methods in real env).
#>
param(
  [Parameter(Mandatory=$true)][string]$Host,
  [int]$Port = 5432,
  [Parameter(Mandatory=$true)][string]$User,
  [Parameter(Mandatory=$true)][string]$DbName,
  [Parameter(Mandatory=$true)][string]$SqlFile,
  [string]$Password
)

if (-not (Test-Path $SqlFile)) {
  Write-Error "SQL file not found: $SqlFile"
  exit 1
}

if (-not $Password) {
  $secure = Read-Host -AsSecureString "Enter DB password for $User@$Host"
  $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

# Build command
$env:PGPASSWORD = $Password
$psql = "psql"
$cmd = "$psql -h $Host -p $Port -U $User -d $DbName -f `"$SqlFile`""
Write-Host "Running: $cmd"

try {
  $proc = Start-Process -FilePath $psql -ArgumentList "-h", $Host, "-p", $Port, "-U", $User, "-d", $DbName, "-f", $SqlFile -NoNewWindow -Wait -PassThru -RedirectStandardOutput out.txt -RedirectStandardError err.txt
  Write-Host "psql exit code: $($proc.ExitCode)"
  if (Test-Path out.txt) { Get-Content out.txt | Write-Host }
  if (Test-Path err.txt) { Get-Content err.txt | Write-Host }
} finally {
  Remove-Variable PGPASSWORD -ErrorAction SilentlyContinue
}
