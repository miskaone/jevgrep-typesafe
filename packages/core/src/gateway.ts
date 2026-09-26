import { type createEvaluationCache, type CacheInput, type JsonValue } from "./cache";
import { setTimeout as delay } from "node:timers/promises";

const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
const TYPESAFE_MODEL = "jev-latest";

export type EvaluationRequest = {
  state: JsonValue;
  questions: Record<string, { type: "boolean"; instructions: string }>;
};

type TypeSafeNoulQuestion = {
  type: "noul";
  criteria: string;
};

type TypeSafeSystemOneRequest = {
  model: string;
  state: JsonValue;
  questions: Record<string, TypeSafeNoulQuestion>;
};

type TypeSafeSystemOneResponse = {
  answers: Record<string, { type: "noul"; noul: number }>;
};

function convertToNoulQuestion(question: { type: "boolean"; instructions: string }): TypeSafeNoulQuestion {
  return {
    type: "noul",
    criteria: `yes: ${question.instructions}\nno: Does not match the criteria.`,
  };
}

export class EvaluationFailure extends Error {
  constructor(
    public readonly kind:
      | "authentication"
      | "request-limit"
      | "provider"
      | "cancelled"
      | "source-invalid",
    public readonly splitEligible = false,
  ) {
    super(`Jev evaluation failed: ${kind}`);
    this.name = "EvaluationFailure";
  }
}

export function createEvaluator(options: {
  apiKey: string;
  cache?: ReturnType<typeof createEvaluationCache>;
  policyVersion?: string;
  baseURL?: string;
  signal: AbortSignal;
  requestLimit?: number;
  timeoutMs?: number;
}) {
  let requests = 0;
  let cacheHits = 0;
  let cooldownUntil = 0;
  const authenticationFailure = new AbortController();
  const typesafeBaseUrl = options.baseURL ?? TYPESAFE_DEFAULT_BASE_URL;

  function assertActive() {
    if (options.signal.aborted) throw new EvaluationFailure("cancelled");
    if (authenticationFailure.signal.aborted) throw new EvaluationFailure("authentication");
  }

  async function callTypeSafeSystemOne(
    request: TypeSafeSystemOneRequest,
    signal: AbortSignal,
  ): Promise<TypeSafeSystemOneResponse> {
    assertActive();
    if (requests >= (options.requestLimit ?? 50_000)) throw new EvaluationFailure("request-limit");
    requests++;

    const url = `${typesafeBaseUrl}/systemone`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(request),
      signal,
    });

    if (response.status === 429) {
      const raw = response.headers.get("retry-after");
      const seconds = raw === null ? NaN : Number(raw);
      const date = raw === null ? NaN : Date.parse(raw);
      const wait =
        Number.isFinite(seconds) && seconds >= 0
          ? seconds * 1000
          : Number.isFinite(date)
            ? Math.max(0, date - Date.now())
            : 1000;
      cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
      const error = new Error("Rate limited") as Error & { statusCode: number };
      error.statusCode = 429;
      throw error;
    }

    if (response.status === 401 || response.status === 403) {
      const error = new Error("Authentication failed") as Error & { statusCode: number };
      error.statusCode = response.status;
      throw error;
    }

    if (!response.ok) {
      const error = new Error(`TypeSafe API error: ${response.status}`) as Error & {
        statusCode: number;
      };
      error.statusCode = response.status;
      throw error;
    }

    return (await response.json()) as TypeSafeSystemOneResponse;
  }

  return {
    get cacheHits() {
      return cacheHits;
    },
    get cacheIssues() {
      return options.cache?.stats().issues ?? [];
    },
    get requests() {
      return requests;
    },
    async evaluate(
      request: EvaluationRequest,
      policy?: { navigation?: boolean; beforeAttempt?: () => Promise<void> },
    ): Promise<Record<string, number>> {
      assertActive();
      const cacheInput: CacheInput = {
        request,
        namespace: {
          model: TYPESAFE_MODEL,
          provider: typesafeBaseUrl,
          policyVersion: options.policyVersion ?? "1",
          parserVersion: "cpython-3.11.3-pyodide-0.25.1-ts-5.9.3",
          promptVersion: "unit-locators-1",
        },
      };
      const cached = await options.cache?.get(cacheInput);
      assertActive();
      if (
        cached &&
        Object.keys(cached).length === Object.keys(request.questions).length &&
        Object.keys(request.questions).every(
          (id) => typeof cached[id] === "number" && cached[id]! >= 0 && cached[id]! <= 1,
        )
      ) {
        cacheHits++;
        return cached;
      }
      const navigation = policy?.navigation === true;
      const multiple = Object.keys(request.questions).length > 1;
      let attemptLimit = navigation && multiple ? 1 : 2;
      for (let attempt = 0; attempt < attemptLimit; attempt++) {
        assertActive();
        if (requests >= (options.requestLimit ?? 50_000))
          throw new EvaluationFailure("request-limit");
        while (cooldownUntil > Date.now()) {
          try {
            await delay(Math.min(60_000, cooldownUntil - Date.now()), undefined, {
              signal: AbortSignal.any([options.signal, authenticationFailure.signal]),
            });
          } catch {
            assertActive();
            throw new EvaluationFailure("cancelled");
          }
        }
        await policy?.beforeAttempt?.();
        assertActive();
        try {
          const noulQuestions = Object.fromEntries(
            Object.entries(request.questions).map(([id, question]) => [
              id,
              convertToNoulQuestion(question),
            ]),
          );
          const result = await callTypeSafeSystemOne(
            {
              model: TYPESAFE_MODEL,
              state: request.state,
              questions: noulQuestions,
            },
            AbortSignal.any([
              options.signal,
              authenticationFailure.signal,
              AbortSignal.timeout(options.timeoutMs ?? 15_000),
            ]),
          );
          const scores = Object.fromEntries(
            Object.keys(request.questions).map((id) => {
              const answer = result.answers[id];
              if (
                !answer ||
                answer.type !== "noul" ||
                !Number.isFinite(answer.noul) ||
                answer.noul < 0 ||
                answer.noul > 1
              )
                throw new Error("Invalid answer");
              return [id, answer.noul];
            }),
          );
          await options.cache?.put(cacheInput, scores);
          return scores;
        } catch (error) {
          assertActive();
          const status =
            error && typeof error === "object" && "statusCode" in error
              ? error.statusCode
              : undefined;
          if (status === 401 || status === 403) {
            authenticationFailure.abort();
            throw new EvaluationFailure("authentication");
          }
          if (requests >= (options.requestLimit ?? 50_000))
            throw new EvaluationFailure("request-limit");
          const name = error instanceof Error ? error.name : "unknown";
          const transient =
            status === 408 ||
            status === 429 ||
            (typeof status === "number" && status >= 500 && status <= 599) ||
            ["TimeoutError", "AbortError"].includes(name);
          if (navigation && status === 429) attemptLimit = Math.max(attemptLimit, 2);
          if ((navigation && !transient) || attempt + 1 === attemptLimit)
            throw new EvaluationFailure(
              "provider",
              navigation && multiple && transient && status !== 429,
            );
        }
      }
      throw new EvaluationFailure("provider");
    },
  };
}
