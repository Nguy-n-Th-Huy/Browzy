// Manual model catalog validation (design.md decision 4 / task 4.2).
//
// Model IDs are opaque, case-sensitive, provider-defined strings — this
// module never invents or guesses one. It only validates a list the user (or
// discovery, task 4.3) supplied: trimmed, nonempty, unique IDs, `{id, label}`
// pairs in explicit order, and exactly one default that references a real
// entry.

export class InvalidModelsError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.name = "InvalidModelsError";
    this.code = "INVALID_MODELS";
  }
}

/**
 * @param {unknown} models
 * @param {unknown} defaultModelId
 * @returns {{ models: Array<{id: string, label: string}>, defaultModelId: string | null }}
 * @throws {InvalidModelsError}
 */
export function validateModels(models, defaultModelId) {
  if (!Array.isArray(models)) {
    throw new InvalidModelsError("models must be an array");
  }

  // An empty catalog is explicitly allowed (design.md: "Start with an empty
  // model list ... never a guessed model"). Only require a default when at
  // least one model exists.
  if (models.length === 0) {
    if (defaultModelId !== null && defaultModelId !== undefined && defaultModelId !== "") {
      throw new InvalidModelsError("defaultModelId must be empty when the model list is empty");
    }
    return { models: [], defaultModelId: null };
  }

  const cleaned = [];
  const seenIds = new Set();
  for (const [index, entry] of models.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new InvalidModelsError(`model at index ${index} must be an object with id/label`);
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!id) {
      throw new InvalidModelsError(`model at index ${index} has an empty id`);
    }
    if (!label) {
      throw new InvalidModelsError(`model "${id}" has an empty label`);
    }
    if (seenIds.has(id)) {
      throw new InvalidModelsError(`duplicate model id "${id}"`);
    }
    seenIds.add(id);
    cleaned.push({ id, label });
  }

  const trimmedDefault = typeof defaultModelId === "string" ? defaultModelId.trim() : "";
  if (!trimmedDefault) {
    throw new InvalidModelsError("a default model is required when the model list is nonempty");
  }
  if (!seenIds.has(trimmedDefault)) {
    throw new InvalidModelsError(`default model id "${trimmedDefault}" does not reference a model in the list`);
  }

  return { models: cleaned, defaultModelId: trimmedDefault };
}

/**
 * @param {unknown} models
 * @param {unknown} defaultModelId
 */
export function tryValidateModels(models, defaultModelId) {
  try {
    return { ok: true, ...validateModels(models, defaultModelId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
