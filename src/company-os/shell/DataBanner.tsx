/** The data-class banner every Company OS page shows (docs/PHASE_2C_BRIEF.md §6.2). */
export const DATA_BANNER_TEXT = "Synthetic/test data only — Q8 open";

export const DataBanner = () => (
  <div
    role="note"
    aria-label="Data policy"
    className="border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm font-medium text-amber-950"
  >
    {DATA_BANNER_TEXT}
  </div>
);
