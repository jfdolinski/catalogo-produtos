// Identifica o tipo do código e valida o dígito verificador dos padrões GTIN.
const GTIN_TYPES = { 8: 'EAN-8', 12: 'UPC-A', 13: 'EAN-13', 14: 'DUN-14' };

function gtinCheckDigitOk(code) {
  const digits = code.split('').map(Number);
  const check = digits.pop();
  const sum = digits
    .reverse()
    .reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function analyzeBarcode(raw, declaredType) {
  const code = String(raw ?? '').trim();
  if (!code) return { error: 'Código de barras vazio' };
  if (code.length > 64) return { error: 'Código de barras muito longo' };

  const gtinType = /^\d+$/.test(code) ? GTIN_TYPES[code.length] : null;
  if (gtinType && !gtinCheckDigitOk(code)) {
    return { error: `Dígito verificador inválido para ${gtinType}: ${code}` };
  }
  const type = (declaredType && String(declaredType).trim().toUpperCase()) || gtinType || 'OUTRO';
  return { code, type };
}
