import { assertEquals } from "@std/assert";
import {
  articleErrorText,
  failClassIsPermanent,
  isDailyLimitFailure,
  isPermanentFailure,
  visitorFailureText,
} from "./failureDisplay.ts";

const dict = {
  errorPrefix: "Ошибка",
  couldNotProcessLabel: "Не удалось обработать",
  permanentFailurePrefix: "Не обработать",
  permanentReasonInsufficientText: "на странице нет текста статьи",
  permanentReasonNotFound: "страница не найдена",
  permanentReasonRemoved: "страница удалена источником",
  permanentReasonSsrfBlocked: "ссылка заблокирована политикой безопасности",
  permanentReasonPaywalled: "страница закрыта платным доступом",
  dailyLimitFailureLabel: "Дневной лимит выжимок исчерпан — обработается автоматически завтра",
};

Deno.test("articleErrorText: a non-permanent (transient/unknown) error is prefixed and shown verbatim", () => {
  assertEquals(
    articleErrorText("internal: summarize: workers ai error: timed out after 90000ms", dict),
    "Ошибка: internal: summarize: workers ai error: timed out after 90000ms",
  );
});

// Regression for the live incident: a card that transitions pending ->
// failed via a live poll merge (see usePendingPoll in ArticleCard.tsx)
// only has `has_error`, never the raw string, so `article.error` stays
// null even though the D1 row itself has a perfectly good message — this
// must render an honest generic label, not a bare "Ошибка: —".
Deno.test("articleErrorText: null error falls back to the generic label, not a bare dash", () => {
  const text = articleErrorText(null, dict);
  assertEquals(text, "Не удалось обработать");
  assertEquals(text.includes("—"), false);
});

Deno.test("articleErrorText: empty-string error falls back to the generic label", () => {
  assertEquals(articleErrorText("", dict), "Не удалось обработать");
});

Deno.test("articleErrorText: whitespace-only error falls back to the generic label", () => {
  assertEquals(articleErrorText("   ", dict), "Не удалось обработать");
});

// --- permanent failures get a distinct, localized "couldn't process: <reason>" message ---

Deno.test("articleErrorText: insufficient-text permanent failure shows the localized reason", () => {
  assertEquals(
    articleErrorText("extraction: insufficient text (7 chars)", dict),
    "Не обработать: на странице нет текста статьи",
  );
});

Deno.test("articleErrorText: a 404 permanent failure shows the localized reason", () => {
  assertEquals(
    articleErrorText("internal: fetch: upstream responded 404", dict),
    "Не обработать: страница не найдена",
  );
});

Deno.test("articleErrorText: a 410 permanent failure shows the localized reason", () => {
  assertEquals(
    articleErrorText("internal: fetch: upstream responded 410", dict),
    "Не обработать: страница удалена источником",
  );
});

Deno.test("articleErrorText: an ssrf-blocked permanent failure shows the localized reason", () => {
  assertEquals(
    articleErrorText("internal: fetch: blocked by ssrf policy", dict),
    "Не обработать: ссылка заблокирована политикой безопасности",
  );
});

Deno.test("articleErrorText: a raw technical error never leaks through for a permanent failure", () => {
  const text = articleErrorText("extraction: insufficient text (7 chars)", dict);
  assertEquals(text.includes("7 chars"), false);
});

// --- isPermanentFailure ---

Deno.test("isPermanentFailure: true for a permanent-classified error", () => {
  assertEquals(isPermanentFailure("extraction: insufficient text (3 chars)"), true);
  assertEquals(isPermanentFailure("internal: fetch: upstream responded 404"), true);
});

Deno.test("isPermanentFailure: false for a transient or unknown error", () => {
  assertEquals(isPermanentFailure("daily-limit"), false);
  assertEquals(
    isPermanentFailure("internal: summarize: summary validation: tldr too short"),
    false,
  );
});

Deno.test("isPermanentFailure: false (not true) for a null/empty error — unknown, not assumed permanent", () => {
  assertEquals(isPermanentFailure(null), false);
  assertEquals(isPermanentFailure(""), false);
  assertEquals(isPermanentFailure("   "), false);
});

// --- daily-limit: dedicated copy, no Retry (owner-mode only — see ArticleCard.tsx) ---

Deno.test("isDailyLimitFailure: true for the exact stored reason string", () => {
  assertEquals(isDailyLimitFailure("daily-limit"), true);
});

Deno.test("isDailyLimitFailure: case-insensitive, substring match (matches classify-failure.ts's own rule)", () => {
  assertEquals(isDailyLimitFailure("DAILY-LIMIT"), true);
  assertEquals(isDailyLimitFailure("  daily-limit  "), true);
});

Deno.test("isDailyLimitFailure: false for other transient/unknown/permanent errors", () => {
  assertEquals(isDailyLimitFailure("internal: summarize: workers ai error: timed out"), false);
  assertEquals(isDailyLimitFailure("extraction: insufficient text (3 chars)"), false);
  assertEquals(isDailyLimitFailure(null), false);
  assertEquals(isDailyLimitFailure(""), false);
});

Deno.test("articleErrorText: a daily-limit failure shows the dedicated message, not the raw error prefix", () => {
  assertEquals(articleErrorText("daily-limit", dict), dict.dailyLimitFailureLabel);
});

// --- visitorFailureText: fail_class only, no raw error text available ---

Deno.test("visitorFailureText: permanent fail_class shows the generic permanent-failure prefix (no specific reason — visitor lacks it)", () => {
  assertEquals(visitorFailureText("permanent", dict), dict.permanentFailurePrefix);
});

Deno.test("visitorFailureText: transient/unknown/null fail_class all get the generic couldNotProcessLabel", () => {
  assertEquals(visitorFailureText("transient", dict), dict.couldNotProcessLabel);
  assertEquals(visitorFailureText("unknown", dict), dict.couldNotProcessLabel);
  assertEquals(visitorFailureText(null, dict), dict.couldNotProcessLabel);
});

Deno.test("visitorFailureText: never leaks a specific permanent reason (visitor never had it to begin with)", () => {
  const text = visitorFailureText("permanent", dict);
  assertEquals(text.includes(dict.permanentReasonInsufficientText), false);
  assertEquals(text.includes(dict.permanentReasonNotFound), false);
});

// --- failClassIsPermanent: visitor-mode Retry-button gate ---

Deno.test("failClassIsPermanent: true only for 'permanent'", () => {
  assertEquals(failClassIsPermanent("permanent"), true);
  assertEquals(failClassIsPermanent("transient"), false);
  assertEquals(failClassIsPermanent("unknown"), false);
  assertEquals(failClassIsPermanent(null), false);
});
