"""Every string a tools/ script prints, raises, or shows as argparse help must be English.
Comments and docstrings may be in any language. This scans string literals inside print(...),
sys.exit(...), any raise SomeError(...), assert messages, and the argparse text kwargs
help/description/epilog/usage/metavar."""
import io
import re
import tokenize
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
CJK = re.compile(r"[\u4e00-\u9fff]")
CALLS = {"print", "SystemExit", "exit"}       # print(...), raise SystemExit(...), sys.exit(...)
KWARGS = {"help", "description", "epilog", "usage", "metavar"}   # argparse text
STRING_TYPES = {tokenize.STRING, getattr(tokenize, "FSTRING_MIDDLE", -1)}  # 3.12+ splits f-strings
PREV_SKIP = {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT}


def cjk_in_user_strings(source):
    """Return [(line, text)] for user-facing string literals that contain CJK characters."""
    hits = []
    toks = list(tokenize.generate_tokens(io.StringIO(source).readline))
    depth = 0
    watch = []   # stack of (depth, kind): strings seen while the stack is non-empty are user-facing
    prev = None  # last token whose type is not in PREV_SKIP; spots `raise SomeError(` regardless of the name
    for i, tok in enumerate(toks):
        if tok.type == tokenize.OP:
            if tok.string in "([{":
                depth += 1
            elif tok.string in ")]}":
                depth -= 1
                while watch and watch[-1][0] > depth:
                    watch.pop()
            elif tok.string == "," and watch and watch[-1] == (depth, "kwarg"):
                watch.pop()
        elif tok.type == tokenize.NAME:
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            calls_here = nxt is not None and nxt.string == "("
            if calls_here and (tok.string in CALLS or (prev is not None and prev.string == "raise")):
                watch.append((depth + 1, "call"))
            elif tok.string in KWARGS and nxt is not None and nxt.string == "=":
                watch.append((depth, "kwarg"))
            elif tok.string == "assert":
                watch.append((depth, "assert"))  # assert cond, "msg": msg reaches the user on failure
        elif tok.type == tokenize.NEWLINE:  # end of the logical line; NL (blank/comment line) must not pop
            while watch and watch[-1][1] == "assert":
                watch.pop()
        elif tok.type in STRING_TYPES and watch and CJK.search(tok.string):
            hits.append((tok.start[0], tok.string[:60]))
        if tok.type not in PREV_SKIP:
            prev = tok
    return hits


def test_fixture_detects_only_user_facing_strings():
    src = '# 註解 中文\nx = "中文變數值"\nprint("中文")\nraise SystemExit(f"錯 {x}")\nap.add_argument("--a", help="說明")\nprint("ok")\nassert x, "中文"\nassert x\nraise ValueError("值錯")\ny = ValueError("非拋出")\n'
    lines = [line for line, _ in cjk_in_user_strings(src)]
    assert lines == [3, 4, 5, 7, 9]


def test_every_tools_script_speaks_english():
    offenders = []
    for path in sorted(TOOLS.glob("*.py")):
        for line, text in cjk_in_user_strings(path.read_text(encoding="utf-8")):
            offenders.append(f"{path.name}:{line}: {text}")
    assert not offenders, "Chinese in a user-facing message (print/raise/help):\n" + "\n".join(offenders)
