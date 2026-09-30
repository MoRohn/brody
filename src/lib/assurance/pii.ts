/**
 * Personal data (PII) taxonomy: which data-model fields hold personal information, how sensitive it is, and whether the
 * field name shows it is protected (hashed, encrypted, tokenised or masked). Matching is on the field name only: values
 * are never read from a database, and no example of real personal data is ever stored or reported.
 */

export type PiiSensitivity = "special" | "high" | "moderate" | "low";

export interface PiiCategory {
  key: string;
  label: string;
  sensitivity: PiiSensitivity;
  /** Regulatory regimes whose scope this kind of data is an indicator for. */
  regimes: string[];
}

export const PII_CATEGORIES: Record<string, PiiCategory> = {
  government: { key: "government", label: "Government identifier", sensitivity: "high", regimes: ["GDPR", "CCPA/CPRA", "State breach laws"] },
  financial: { key: "financial", label: "Financial account or card", sensitivity: "high", regimes: ["PCI DSS", "GLBA", "GDPR", "CCPA/CPRA"] },
  credential: { key: "credential", label: "Credential or secret", sensitivity: "high", regimes: ["GDPR", "State breach laws"] },
  health: { key: "health", label: "Health information", sensitivity: "special", regimes: ["HIPAA", "GDPR Art. 9"] },
  biometric: { key: "biometric", label: "Biometric data", sensitivity: "special", regimes: ["GDPR Art. 9", "BIPA", "CCPA/CPRA"] },
  demographic: { key: "demographic", label: "Special-category demographic", sensitivity: "special", regimes: ["GDPR Art. 9", "CCPA/CPRA"] },
  birth: { key: "birth", label: "Date of birth or age", sensitivity: "moderate", regimes: ["GDPR", "COPPA"] },
  contact: { key: "contact", label: "Contact details", sensitivity: "moderate", regimes: ["GDPR", "CCPA/CPRA", "CAN-SPAM/PECR"] },
  name: { key: "name", label: "Personal name", sensitivity: "moderate", regimes: ["GDPR", "CCPA/CPRA"] },
  address: { key: "address", label: "Postal address or precise location", sensitivity: "moderate", regimes: ["GDPR", "CCPA/CPRA"] },
  online: { key: "online", label: "Online or device identifier", sensitivity: "low", regimes: ["GDPR", "ePrivacy", "CCPA/CPRA"] },
  employment: { key: "employment", label: "Employment or compensation", sensitivity: "moderate", regimes: ["GDPR", "CCPA/CPRA"] },
};

export const SENSITIVITY_ORDER: PiiSensitivity[] = ["special", "high", "moderate", "low"];
export const SENSITIVITY_LABEL: Record<PiiSensitivity, string> = { special: "Special category", high: "High", moderate: "Moderate", low: "Low" };

/** Patterns on the compacted field name (lower case, separators removed). Order matters: the first match wins. */
const FIELD_PATTERNS: [RegExp, string][] = [
  [/^(ssn|socialsecurity(number|no)?|nationalid(number)?|nationalinsurance(number)?|nino|passport(number|no)?|driverslicen[cs]e(number)?|driverlicen[cs]e(number)?|licen[cs]enumber|taxid(number)?|tin|itin|aadhaar|nhsnumber|personalnumber|personnummer|cpf|curp)$/, "government"],
  [/(^card$|cardnumber|creditcard|debitcard|ccnumber|^pan$|cvv|cvc|cardcvc|securitycode|iban|bankaccount|accountnumber|routingnumber|sortcode|swiftcode|bic$)/, "financial"],
  [/(password|passwd|^pwd$|passcode|^pin$|pincode|securityanswer|secretanswer|mfasecret|totpsecret|otpsecret|recoverycodes?|resettoken|refreshtoken|accesstoken|apikey|apisecret|clientsecret|sessiontoken)/, "credential"],
  [/(diagnos[ie]s|medical|healthrecord|healthcondition|prescription|medication|allerg(y|ies)|bloodtype|disabilit(y|ies)|symptoms?|treatment|insurancenumber|policynumber|mrn$)/, "health"],
  [/(fingerprint|faceid|faceembedding|faceprint|biometric|retina|iris(scan)?|voiceprint)/, "biometric"],
  [/^(race|ethnicity|religion|religiousbelief|sexualorientation|politicalopinion|politicalaffiliation|tradeunion(membership)?|criminalrecord|criminalhistory)$/, "demographic"],
  [/^(dob|dateofbirth|birthdate|birthday|birthdt|age)$/, "birth"],
  [/^(e?mail|emailaddress|useremail|contactemail|personalemail|workemail|phone|phonenumber|phoneno|mobile|mobilenumber|mobilephone|cellphone|telephone|tel|fax|whatsapp)$/, "contact"],
  [/^(firstname|lastname|fullname|surname|givenname|familyname|middlename|maidenname|displayname|legalname|forename|nickname)$/, "name"],
  [/^(address|addressline\d?|streetaddress|street|homeaddress|billingaddress|shippingaddress|mailingaddress|postcode|postalcode|zip|zipcode|latitude|longitude|lat|lng|lon|geolocation|geo|coordinates|gps)$/, "address"],
  [/^(ip|ipaddress|ipaddr|remoteaddr|clientip|useragent|deviceid|devicefingerprint|advertisingid|idfa|gaid|macaddress|cookieid|visitorid|imei)$/, "online"],
  [/^(salary|income|wage|compensation|payrate|employer|jobtitle|employeenumber|employeeid)$/, "employment"],
];

/** Names that mention personal data but are not personal data themselves (flags, templates, counts, timestamps). */
const NOT_PII = /(verified|verification|confirmed|enabled|disabled|consent|optin|optout|opted|template|subject|count|format|status|sent|notification|preference|policy|provider|changed|updated|created|required|visible|hint|label|placeholder|regex|pattern|valid|length|expires?|expiry|attempts|strength|rules|minlength|maxlength|field|input|column)/;
const HASHED = /(hash|hashed|digest|bcrypt|argon|scrypt|salt)/;
const ENCRYPTED = /(encrypted|encrypt|cipher|ciphertext|enc$|^enc|sealed|vault)/;
const TOKENISED = /(token(ised|ized)?$|fingerprinttoken|reference$|^last4|last4$|lastfour|masked|redacted|truncated|suffix$)/;
/** Models that describe a person, so a bare "name" field is a personal name. */
export const PERSON_MODEL = /(user|customer|person|people|member|employee|staff|patient|client|contact|account|profile|student|applicant|candidate|guest|subscriber|lead|owner|author|driver|tenant|resident|citizen|donor|volunteer|child|parent|guardian|beneficiary|buyer|seller|traveller|traveler|passenger)/i;
/** Models that indicate children's data. */
export const CHILD_MODEL = /(child|children|minor|kid|student|pupil|parentalconsent|guardian)/i;
export const HEALTH_MODEL = /(patient|diagnos|medical|health|prescription|clinic|appointment|ehr|emr|treatment)/i;

export type Protection = "hashed" | "encrypted" | "tokenised" | "none";

export interface PiiFieldMatch { category: PiiCategory; protection: Protection }

export const compact = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Classify one data-model field; undefined when it is not personal data. */
export function classifyField(field: string, modelName = "", fieldType = ""): PiiFieldMatch | undefined {
  const c = compact(field);
  if (!c || c.length > 48) return undefined;
  const protection: Protection = HASHED.test(c) ? "hashed" : ENCRYPTED.test(c) || /encrypt/i.test(fieldType) ? "encrypted" : TOKENISED.test(c) ? "tokenised" : "none";
  // Strip the protection affix so "passwordHash", "ssnEncrypted" and "cardLast4" still classify as what they protect.
  const core = c.replace(/(hashed|hash|digest|encrypted|encrypt|ciphertext|cipher|enc|token(ised|ized)?|last4|lastfour|masked|redacted|truncated|salt)/g, "") || c;
  if (/^(id|uuid|userid|customerid|createdby|updatedby|ownerid)$/.test(core)) return undefined;
  if (core === "name" || core === "username") return PERSON_MODEL.test(modelName) ? { category: PII_CATEGORIES[core === "name" ? "name" : "online"], protection } : undefined;
  if ((core === "gender" || core === "sex") && PERSON_MODEL.test(modelName)) return { category: PII_CATEGORIES.demographic, protection };
  for (const [re, key] of FIELD_PATTERNS) if (re.test(core)) {
    // Unanchored patterns ("password", "cardnumber") also match flags and metadata about the data ("passwordChangedAt").
    if (!re.source.startsWith("^(") && NOT_PII.test(core)) return undefined;
    // Token-like names (resetToken, apiKey) are credentials; "token" only means tokenised for card and account data.
    const p = key === "credential" && protection === "tokenised" ? "none" : protection;
    return { category: PII_CATEGORIES[key], protection: p };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Personal data written into source files: consumer e-mail addresses, national identifiers and card numbers.

export interface PiiValueMatch { kind: string; line: number; preview: string }

const CONSUMER_MAIL = /\b[A-Za-z0-9._%+-]{2,64}@(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|web|mail|yandex|zoho|comcast|verizon|att|qq|163|126)\.(?:com|net|de|fr|co\.uk|ru|me|ch)\b/gi;
const SSN = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const SSN_CONTEXT = /\b(ssn|social[\s_-]?security|tax[\s_-]?id|tin)\b/i;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
/** Published test numbers from card networks and payment providers. */
const TEST_CARDS = new Set(["4242424242424242", "4111111111111111", "4000056655665556", "5555555555554444", "5200828282828210", "5105105105105100", "378282246310005", "371449635398431", "6011111111111117", "6011000990139424", "3056930009020004", "30569309025904", "3566002020360505", "3530111333300000", "4012888888881881", "4222222222222", "4000000000000002", "4000000000009995", "4000000000000077", "4000002500003155", "4000000000003220", "6200000000000005", "5454545454545454"]);
const PLACEHOLDER_LINE = /(example|placeholder|sample|dummy|fake|mock|stub|lorem|test|xxx|redacted|your[_-]?)/i;

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const maskMail = (m: string) => { const [u, d] = m.split("@"); return `${u.slice(0, 1)}***@${d}`; };

/** Personal data values found in a file's text. Previews are masked; the values themselves are never kept. */
export function detectPiiValues(text: string): PiiValueMatch[] {
  const out: PiiValueMatch[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < 50; i++) {
    const line = lines[i];
    if (line.length > 2000 || PLACEHOLDER_LINE.test(line)) continue;
    for (const m of line.matchAll(CONSUMER_MAIL)) out.push({ kind: "Personal e-mail address", line: i + 1, preview: maskMail(m[0]) });
    if (SSN_CONTEXT.test(line)) for (const m of line.matchAll(SSN)) out.push({ kind: "US Social Security number", line: i + 1, preview: `***-**-${m[0].slice(-4)}` });
    for (const m of line.matchAll(CARD)) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits) || TEST_CARDS.has(digits)) continue;
      if (!/^(4|5[1-5]|2[2-7]|3[47]|6(?:011|5))/.test(digits) || !luhn(digits)) continue;
      out.push({ kind: "Payment card number", line: i + 1, preview: `**** ${digits.slice(-4)}` });
    }
  }
  return out;
}
