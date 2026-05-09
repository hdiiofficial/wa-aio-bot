import { create, all } from "mathjs";

const math = create(all, {});

const HAS_OPERATOR = /[+\-*\/\^×÷%]/;

function hasLettersExceptSqrt(str) {
    return /[a-zA-Z]/.test(str.replace(/sqrt/gi, "    "));
}

function preprocessExpr(raw) {
    let expr = raw.trim();
    expr = expr.replace(/×/g, "*");
    expr = expr.replace(/÷/g, "/");
    expr = expr.replace(/√/g, "sqrt");
    expr = expr.replace(/(\d)[.,](\d{3})(?=\D|$)/g, "$1$2");
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*%(?!\s*\d)/g, "($1/100)");
    expr = expr.replace(/(\d)\s*%\s*(\d)/g, "$1%$2");
    expr = expr.replace(/\s+/g, "");
    expr = expr.replace(/,/g, ".");
    return expr;
}

const PROCESSED_SAFE_RE = /^[0-9+\-*/^%.()sqrtSQRT]+$/;

function formatResult(num) {
    if (!isFinite(num)) return null;
    let formatted;
    if (Number.isInteger(num)) {
        formatted = num.toLocaleString("id-ID");
    } else {
        const fixed = num.toFixed(8).replace(/\.?0+$/, "");
        const [intPart, decPart] = fixed.split(".");
        const intFormatted = parseInt(intPart).toLocaleString("id-ID");
        formatted = decPart ? `${intFormatted},${decPart}` : intFormatted;
    }
    const abs = Math.abs(num);
    let shorthand = "";
    if (abs >= 1_000_000_000) shorthand = ` _(${(num/1_000_000_000).toFixed(2).replace(/\.?0+$/,"")} M)_`;
    else if (abs >= 1_000_000) shorthand = ` _(${(num/1_000_000).toFixed(2).replace(/\.?0+$/,"")} jt)_`;
    return formatted + shorthand;
}

function beautifyExpr(original) {
    let expr = original.trim();
    expr = expr.replace(/\*/g, " × ");
    expr = expr.replace(/\//g, " ÷ ");
    expr = expr.replace(/\+/g, " + ");
    expr = expr.replace(/([0-9)])\s*-\s*/g, "$1 - ");
    expr = expr.replace(/\s{2,}/g, " ").trim();
    return expr;
}

export function isMathExpression(text) {
    const t = text.trim();
    if (!t) return false;
    if (hasLettersExceptSqrt(t)) return false;
    if (!/\d/.test(t)) return false;
    const hasSqrt = /sqrt\s*\(\s*\d/i.test(t);
    if (!HAS_OPERATOR.test(t) && !hasSqrt) return false;
    return true;
}

export function evaluateMath(rawText) {
    try {
        const expr = preprocessExpr(rawText);
        if (!PROCESSED_SAFE_RE.test(expr)) return null;
        const raw = math.evaluate(expr);
        const num = typeof raw === "number" ? raw : Number(raw);
        if (!isFinite(num) || isNaN(num)) return null;
        const formatted = formatResult(num);
        if (!formatted) return null;
        return { expr: beautifyExpr(rawText), result: formatted, num };
    } catch (_) {
        return null;
    }
}

export function safeEval(expr) {
    try {
        const processed = preprocessExpr(expr);
        if (!PROCESSED_SAFE_RE.test(processed)) return null;
        const result = math.evaluate(processed);
        return typeof result === "number" ? result : Number(result);
    } catch (_) {
        return null;
    }
}
