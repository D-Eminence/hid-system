// Windows ACL equivalents for the existing POSIX private fixture checks.
// Paths stay out of diagnostics; no recipient, credential or file body is read.
import { execFileSync } from 'node:child_process';

function windows(script, path) {
  if (typeof path !== 'string' || path.includes('\0')) throw new Error('Private path rejected');
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p='${path.replaceAll("'", "''")}'; ` + script;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 10000 }).trim();
  } catch { throw new Error('Private custody check failed'); }
}

export function assertWindowsPrivate(path) {
  const raw = windows(`
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    $a=Get-Acl -LiteralPath $p;
    $owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;
    $ok=$a.AreAccessRulesProtected -and $owner -eq $sid;
    foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544')) {$ok=$false}
    }
    [bool]$ok | ConvertTo-Json -Compress
  `, path);
  if (raw !== 'true') throw new Error('Private custody check failed');
}

export function protectWindowsPrivate(path, directory) {
  windows(`
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $a=${directory ? "[Security.AccessControl.DirectorySecurity]::new()" : "[Security.AccessControl.FileSecurity]::new()"};
    $a.SetAccessRuleProtection($true,$false);
    $a.SetOwner($sid);
    $inherit=${directory ? "[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'" : "[Security.AccessControl.InheritanceFlags]::None"};
    foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
      $identity=[Security.Principal.SecurityIdentifier]::new($s);
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl',$inherit,'None','Allow');
      $a.AddAccessRule($rule)
    }
    # Persist only the modified owner/DACL sections. Set-Acl can attempt SACL
    # changes and require SeSecurityPrivilege on an existing broad-read file.
    $item=${directory ? "[IO.DirectoryInfo]::new($p)" : "[IO.FileInfo]::new($p)"};
    $item.SetAccessControl($a)
  `, path);
  assertWindowsPrivate(path);
}
