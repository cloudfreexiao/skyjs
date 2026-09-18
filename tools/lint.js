#!/usr/bin/env node
// tools/lint.js -- zero-dependency style checker for SkyJS JS sources.
// Enforces the JS parts of AGENTS.md "编码约定" that are verifiable statically:
//   1. syntax validity            (via `node --check`)
//   2. no `var` declarations      (const/let only)
//   3. declared identifiers are lower_snake_case (UPPER_SNAKE for constants)
//   4. no leading-tab indentation (4-space rule)
//   5. retired pre-convention names (intcommand/genid/...) must not return
// Boundaries: C-injected globals (skynetcore.*, __snjs_*) are C-side contracts
// and keep their C naming; identifiers inside strings/comments are not checked.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SNAKE = /^[a-z_][a-z0-9_]*$/;     // lower_snake_case
const UPPER = /^[A-Z][A-Z0-9_]*$/;      // UPPER_SNAKE_CASE (constants)
// keywords that look like `name(...) {` but are control flow, not method shorthand
const NON_METHOD = new Set(["if", "for", "while", "switch", "catch", "function"]);

// retired pre-convention names (mostly C-injected skynetcore methods); they
// must not sneak back into QuickJS-side code (tools/ is exempt: the checker
// itself mentions them in this very list)
const FORBIDDEN = [
    /\bintcommand\b/, /\bgenid\b/, /\breadfile\b/, /\bwritefile\b/,
];

const DECL_PATTERNS = [
    // function declarations: `function name(` / `async function name(`
    { re: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    // const/let simple declarations (destructuring skipped): `const name =`
    { re: /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/, kind: "variable" },
    // object literal keys with function values: `name: function` / `name: async function`
    { re: /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function\b/, kind: "key" },
    // method shorthand: `name(args) {` (control-flow keywords excluded)
    { re: /^\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/, kind: "method" },
];

function collect(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) collect(p, out);
        else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
    }
    return out;
}

function check_file(file) {
    const errors = [];
    // tools/ scripts run under node, not QuickJS: exempt from the FORBIDDEN list
    // (the checker itself mentions the retired names in its own rule table)
    const is_tool = /(^|[\\/])tools([\\/])/.test(file);
    let lines;
    try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (e) {
        errors.push(`${file}:1: syntax error (node --check)`);
        errors.push(String(e.stderr || "").split("\n").slice(0, 4).join("\n"));
        return errors;
    }
    lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
        const no = i + 1;
        if (/^\t/.test(line)) errors.push(`${file}:${no}: leading tab indent (use 4 spaces)`);
        if (/\bvar\s+[A-Za-z_$]/.test(line)) errors.push(`${file}:${no}: 'var' declaration (use const/let)`);
        if (!is_tool) {
            for (const fr of FORBIDDEN) {
                if (fr.test(line)) errors.push(`${file}:${no}: retired pre-convention name`);
            }
        }
        for (const { re, kind } of DECL_PATTERNS) {
            const m = line.match(re);
            if (!m) continue;
            const name = m[1];
            if (NON_METHOD.has(name)) continue;
            if (!SNAKE.test(name) && !UPPER.test(name)) {
                errors.push(`${file}:${no}: ${kind} '${name}' violates lower_snake_case`);
            }
            break; // one declaration pattern per line
        }
    });
    return errors;
}

function main() {
    const targets = process.argv.slice(2);
    if (targets.length === 0) {
        console.error("usage: node tools/lint.js <dir|file>...");
        process.exit(2);
    }
    const files = [];
    for (const t of targets) {
        if (fs.statSync(t).isDirectory()) collect(t, files);
        else files.push(t);
    }
    files.sort();
    let bad = 0;
    for (const f of files) {
        const errs = check_file(f);
        if (errs.length) {
            bad += 1;
            console.log(errs.join("\n"));
        }
    }
    console.log(`lint: ${files.length} file(s) checked, ${bad} file(s) with problems`);
    process.exit(bad ? 1 : 0);
}

main();
