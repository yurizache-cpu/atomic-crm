import { NOT_FOUND_TEXT } from "./queryErrors";

/** What a detail page shows for a record id the contract refuses, as for OS404. */
export const RecordNotFound = () => <p role="alert">{NOT_FOUND_TEXT}</p>;
