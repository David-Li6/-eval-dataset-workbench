"""Report possible publication leaks without printing matched secret values."""
from pathlib import Path
import argparse
import ipaddress
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--release', action='store_true', help='Also reject generated/private artifacts in a fresh release tree.')
parser.add_argument('--forbid-text', action='append', default=[], help='Additional private text to reject; matched text is never printed.')
args = parser.parse_args()
RUNTIME_DIRS = {'data','test-results','uploads','exports','backups','__pycache__','node_modules','.venv','venv','coverage','.vscode','.idea','.codex','.agents','.aws'}
PRIVATE_SUFFIXES = {'.log','.pid','.tmp','.pyc','.pyo','.pem','.key','.pfx','.p12','.kdbx','.zip'}
TEXT_SUFFIXES = {'.md','.mjs','.js','.py','.json','.jsonl','.html','.css','.svg','.txt','.cmd','.ps1','.yml','.yaml','.csv','.tsv'}
SAFE_DOMAINS = ('example.com','example.org','example.net','example.test')
rules = [
    ('model-api-token', re.compile('s' + r'k-[A-Za-z0-9_-]{20,}')),
    ('github-token', re.compile(r'(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})')),
    ('cloud-access-key', re.compile(r'(?:AKIA|ASIA)[A-Z0-9]{16}')),
    ('private-key-block', re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----')),
    ('encrypted-windows-credential', re.compile('AQAA' + r'ANCMnd8[A-Za-z0-9+/=]{40,}')),
    ('personal-home-path', re.compile(r'(?:[A-Za-z]:[/\\]Users[/\\](?!Public(?:[/\\]|$))[^/\\\s\'";]+|/(?:Users|home)/[^/\s\'";]+)')),
    ('mobile-number', re.compile(r'(?<!\d)1[3-9]\d{9}(?!\d)')),
    ('literal-credential', re.compile(r'''(?:api[_-]?key|secret|access[_-]?token|password)\s*[:=]\s*(['"])([^'"\r\n]{16,})\1''',re.I)),
    ('literal-bearer', re.compile(r'Bearer\s+([A-Za-z0-9_./+-]{16,})')),
    ('url-credential', re.compile(r'''https?://[^/@\s'"]+:[^/@\s'"]+@[^/\s'"]+''')),
    ('email-address', re.compile(r'(?<![\w.+-])[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')),
]
for n,value in enumerate(args.forbid_text,1):
    if value:
        rules.append((f'custom-private-text-{n}',re.compile(re.escape(value),re.I)))
ipv4 = re.compile(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])')
findings=[]
def add(rule, relative, line=0):
    findings.append((relative,line,rule))

def allowed_fixture(rule,match,relative):
    # Tests use local mocks and deliberately invalid request values, never real credentials.
    if not relative.startswith('tests/'):
        return False
    value=match.group(2) if rule=='literal-credential' else match.group(1) if rule=='literal-bearer' else match.group(0)
    if rule in {'literal-credential','literal-bearer','model-api-token'}:
        return value.startswith(('fixture-','test-','provider-test-','mock-','sk-test-','sk-mock-'))
    return rule=='url-credential' and value==('http://'+'user:pass@'+'localhost:8000')

checked=0
for item in sorted(ROOT.rglob('*')):
    relative=item.relative_to(ROOT).as_posix()
    parts=item.relative_to(ROOT).parts
    if '.git' in parts:
        continue
    blocked=next((part for part in parts if part in RUNTIME_DIRS),None)
    if blocked:
        if args.release and len(parts)==parts.index(blocked)+1:
            add('private-or-generated-directory',relative)
        continue
    if item.is_symlink():
        add('symlink-not-reviewed',relative)
        continue
    if not item.is_file():
        continue
    if item.suffix.lower() in PRIVATE_SUFFIXES or (item.name.startswith('.env') and item.name!='.env.example'):
        add('private-or-generated-file',relative)
        continue
    if item.name in {'providers.json','config.json','prompts.json','workflow.json'}:
        add('runtime-state-file',relative)
        continue
    if item.suffix.lower() not in TEXT_SUFFIXES and item.name not in {'.gitignore','.gitattributes'}:
        if args.release:
            add('unreviewed-file-type',relative)
        continue
    try:
        content=item.read_text(encoding='utf-8-sig')
    except UnicodeError:
        add('non-text-content',relative)
        continue
    checked+=1
    for line_number,line in enumerate(content.splitlines(),1):
        for rule,pattern in rules:
            for match in pattern.finditer(line):
                if allowed_fixture(rule,match,relative):
                    continue
                if rule=='email-address':
                    domain=match.group(0).split('@',1)[1].lower()
                    if domain.endswith(('.example','.test','.invalid','.localhost')) or domain in SAFE_DOMAINS:
                        continue
                add(rule,relative,line_number)
        for match in ipv4.finditer(line):
            try:
                address=ipaddress.ip_address(match.group(0))
            except ValueError:
                continue
            if address.is_loopback or address.is_unspecified:
                continue
            if any(address in ipaddress.ip_network(net) for net in ('192.0.2.0/24','198.51.100.0/24','203.0.113.0/24')):
                continue
            if address.is_private or address.is_link_local:
                add('internal-network-address',relative,line_number)

findings=sorted(set(findings))
for relative,line,rule in findings:
    print(f'{relative}:{line} [{rule}] value hidden')
print(f'Publication scan: {checked} text files checked, {len(findings)} findings.')
if findings:
    sys.exit(1)
