export const validateCommercialNoteRequired = (
  value: string | null | undefined,
) => {
  const hasText = typeof value === "string" && value.trim().length > 0;

  return hasText ? undefined : "resources.notes.validation.note_required";
};
