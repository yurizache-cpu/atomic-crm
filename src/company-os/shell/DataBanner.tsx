/** The data-class banner every Company OS page shows (docs/PHASE_2C_BRIEF.md §6.2). */
export const DATA_BANNER_TEXT =
  "Ambiente de teste · somente dados sintéticos ou de teste · Q8 em aberto";

export const DataBanner = () => (
  <div
    role="note"
    aria-label="Política de dados"
    className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-center text-xs font-medium text-amber-900 dark:text-amber-200"
  >
    {DATA_BANNER_TEXT}
  </div>
);
