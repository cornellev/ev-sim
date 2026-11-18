import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

// Node reports every Windows directory as 0777, so owner-only privacy is the DACL.
const FILE_READ_DATA = 0x1;
const GENERIC_READ = 0x80000000;
const ACCESS_ALLOW = 0;
const ACCESS_DENY = 1;
const PROPAGATION_INHERIT_ONLY = 0x2;
const POWERSHELL_TIMEOUT_MS = 15000;
const protectedPaths = new Set();

const QUERY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:CEV_SIM_OWNER_ONLY_PATH
if ([string]::IsNullOrWhiteSpace($path)) { throw 'Windows owner-only path is missing.' }
$acl = Get-Acl -LiteralPath $path
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rows = foreach ($ace in @($acl.Access)) {
    $id = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    [pscustomobject]@{
        sid = $id
        type = [int]$ace.AccessControlType
        rights = [int]$ace.FileSystemRights
        propagation = [int]$ace.PropagationFlags
    }
}
@{ sid = $sid; aces = @($rows) } | ConvertTo-Json -Compress
`;

const PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:CEV_SIM_OWNER_ONLY_PATH
if ([string]::IsNullOrWhiteSpace($path)) { throw 'Windows owner-only path is missing.' }
$acl = Get-Acl -LiteralPath $path
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$inheritance = if ($env:CEV_SIM_OWNER_ONLY_DIRECTORY -eq '1') {
    [System.Security.AccessControl.InheritanceFlags]'ObjectInherit, ContainerInherit'
} else {
    [System.Security.AccessControl.InheritanceFlags]::None
}
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$type = [System.Security.AccessControl.AccessControlType]::Allow
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $rights, $inheritance, $propagation, $type)
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($existing) }
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;

function powershellExe() {
    return path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function encodedCommand(script) {
    return Buffer.from(script, "utf16le").toString("base64");
}

function runOwnerOnlyPowerShell(script, extraEnv) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const child = spawn(powershellExe(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(script)], {
            env: { ...process.env, ...extraEnv },
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        timer = setTimeout(() => {
            child.kill();
            finish(reject, new Error("Windows owner-only ACL command timed out."));
        }, POWERSHELL_TIMEOUT_MS);
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            if (stdout.length > 1_000_000) {
                child.kill();
                finish(reject, new Error("Windows owner-only ACL report is too large."));
            }
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", (error) => finish(reject, error));
        child.on("close", (code) => {
            if (code !== 0) {
                finish(reject, new Error(stderr.trim() || `Windows owner-only ACL command exited ${code}.`));
                return;
            }
            finish(resolve, stdout.trim());
        });
    });
}

export function unixModeIsOwnerOnly(mode) {
    return Number.isInteger(mode) && (mode & 0o077) === 0;
}

export function aclIsOwnerOnly(aces, currentSid) {
    if (typeof currentSid !== "string" || !currentSid) return false;
    const owner = currentSid.toLowerCase();
    let readable = false;
    for (const ace of aces) {
        if (!ace || typeof ace.sid !== "string") return false;
        if ((Number(ace.propagation) & PROPAGATION_INHERIT_ONLY) !== 0) continue;
        const type = Number(ace.type);
        if (type === ACCESS_DENY) return false;
        if (type !== ACCESS_ALLOW || ace.sid.toLowerCase() !== owner) return false;
        const rights = Number(ace.rights);
        if ((rights & FILE_READ_DATA) !== 0 || (rights & GENERIC_READ) !== 0) readable = true;
    }
    return readable;
}

export function aclReportIsOwnerOnly(report) {
    if (!report || typeof report.sid !== "string") return false;
    const raw = report.aces == null ? [] : Array.isArray(report.aces) ? report.aces : [report.aces];
    return aclIsOwnerOnly(raw.map((ace) => ({
        sid: ace?.sid ?? ace?.Sid,
        type: ace?.type ?? ace?.Type,
        rights: ace?.rights ?? ace?.Rights,
        propagation: ace?.propagation ?? ace?.Propagation ?? 0,
    })), report.sid);
}

async function queryWindowsAcl(nodePath) {
    const stdout = await runOwnerOnlyPowerShell(QUERY_SCRIPT, {
        CEV_SIM_OWNER_ONLY_PATH: path.win32.resolve(nodePath),
    });
    try {
        return JSON.parse(stdout);
    } catch (error) {
        throw new Error("Windows owner-only ACL report is invalid.", { cause: error });
    }
}

async function restrictWindowsAcl(nodePath, { directory }) {
    const stat = await fs.lstat(nodePath);
    if (stat.isSymbolicLink()) return false;
    await runOwnerOnlyPowerShell(PROTECT_SCRIPT, {
        CEV_SIM_OWNER_ONLY_PATH: path.win32.resolve(nodePath),
        CEV_SIM_OWNER_ONLY_DIRECTORY: directory ? "1" : "0",
    });
    return true;
}

export async function assertOwnerOnly(nodePath, stat, {
    directory = false,
    fail = (cause) => Object.assign(new Error(directory ? "Owner-only directory required." : "Owner-only file required."), { cause }),
    platform = process.platform,
    queryAcl = queryWindowsAcl,
} = {}) {
    const typeOk = directory ? Boolean(stat?.isDirectory?.()) : Boolean(stat?.isFile?.());
    const link = Boolean(stat?.isSymbolicLink?.());
    let allowed = false;
    let cause = null;
    if (typeOk && !link) {
        try {
            allowed = platform === "win32"
                ? aclReportIsOwnerOnly(await queryAcl(nodePath))
                : unixModeIsOwnerOnly(stat.mode);
        } catch (error) {
            cause = error;
        }
    }
    if (!allowed) throw fail(cause);
}

export async function protectOwnerOnly(nodePath, {
    directory = false,
    platform = process.platform,
    restrictAcl = restrictWindowsAcl,
} = {}) {
    if (platform !== "win32") {
        const stat = await fs.lstat(nodePath);
        if (!stat.isSymbolicLink()) await fs.chmod(nodePath, directory ? 0o700 : 0o600);
        return;
    }
    // shortcut: a path protected in this process is not rewritten again, restart to repair an ACL widened later.
    const key = path.win32.resolve(nodePath).toLowerCase();
    if (protectedPaths.has(key)) return;
    if (await restrictAcl(nodePath, { directory }) !== false) protectedPaths.add(key);
}
