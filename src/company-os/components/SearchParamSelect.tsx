import { useId, type ChangeEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router";

// A list filter kept in the location's search parameters, so a filtered list
// is a link (the Overview's counts link to them) and Back restores it. It only
// narrows a read: every value it can set is one of `options`, and the screen
// validates the parameter again before it becomes an argument.

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export const SearchParamSelect = ({
  label,
  param,
  options,
  allLabel = "All",
}: {
  label: string;
  param: string;
  options: readonly SelectOption[];
  allLabel?: string;
}) => {
  const id = useId();
  const [params, setParams] = useSearchParams();
  const current = params.get(param) ?? "";
  const value = options.some((option) => option.value === current)
    ? current
    : "";

  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = new URLSearchParams(params);
    if (event.target.value === "") {
      next.delete(param);
    } else {
      next.set(param, event.target.value);
    }
    setParams(next);
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={onChange}
        className="h-9 rounded-md border bg-background px-2 text-sm"
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
};

export const FilterBar = ({ children }: { children: ReactNode }) => (
  <div role="group" aria-label="Filters" className="flex flex-wrap gap-4">
    {children}
  </div>
);
