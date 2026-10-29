import { useId, useState } from "react";
import { api, type RouterOutputs } from "@/utils/api";
import { getCurrentSemester, getValidSemesters } from "@/utils/semester";
import { formatSemester } from "@/utils/venmoPayment";
import { SendLoginEmail } from "@/components/SendLoginEmail";
import { toast } from "react-toastify";

type WatchedSection = RouterOutputs["user"]["getWatchedClasses"][number];
type SearchSection = RouterOutputs["catalog"]["searchSections"]["sections"][number];
const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed";

export function SectionSearch({
  changingSection,
  onComplete,
}: {
  changingSection?: WatchedSection;
  onComplete?: () => void;
}) {
  const inputId = useId();
  const [semester, setSemester] = useState(changingSection?.semester || getCurrentSemester());
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selected, setSelected] = useState<SearchSection | null>(null);
  const [message, setMessage] = useState("");
  const { data: hasUser } = api.user.hasUser.useQuery();
  const userQuery = api.user.getUserInfo.useQuery(undefined, { enabled: Boolean(hasUser) });
  const watchedQuery = api.user.getWatchedClasses.useQuery(undefined, { enabled: Boolean(hasUser) });
  const user = userQuery.data;
  const watched = watchedQuery.data;
  const search = api.catalog.searchSections.useQuery(
    { semester, query: submittedQuery },
    { enabled: submittedQuery.length >= 2, retry: false },
  );
  const add = api.user.addWatchedClass.useMutation();
  const change = api.user.changeWatchedClass.useMutation();
  const utils = api.useUtils();
  const pending = add.isPending || change.isPending;
  const selectedAlreadyWatched =
    selected && watched?.some((entry) => entry.section === selected.section && entry.semester === selected.semester);

  const save = async () => {
    if (!selected || !user || !watched || pending || selectedAlreadyWatched) {
      return;
    }
    setMessage("");
    try {
      if (changingSection) {
        await change.mutateAsync({
          id: changingSection.id,
          sectionNumber: selected.section,
          semester: selected.semester,
        });
        toast.success(`Payment moved to section ${selected.section}. No additional payment is needed.`);
      } else {
        await add.mutateAsync({
          sectionNumber: selected.section,
          semester: selected.semester,
          department: selected.department,
          email: user.email,
        });
        toast.success(`Now watching ${selected.courseNumber}, section ${selected.section}.`);
      }
      await Promise.all([utils.user.getWatchedClasses.invalidate(), utils.user.getUserInfo.invalidate()]);
      setSelected(null);
      setMessage(
        changingSection
          ? "Section changed. Your payment is still active."
          : "Section added. Manage your alerts and optional text payments in your dashboard.",
      );
      onComplete?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save this section. Please try again.");
    }
  };

  return (
    <section
      className="min-w-0 space-y-4"
      aria-label={changingSection ? "Find a replacement section" : "Search and add sections"}
    >
      <div>
        <h2 className="text-2xl font-bold tracking-tight">
          {changingSection ? "Find a replacement section" : "Search and add sections"}
        </h2>
        <p className="mt-1 text-sm leading-6 text-gray-600">
          {changingSection
            ? `Your payment stays active for ${formatSemester(semester)}. You can change sections until your first availability text is sent.`
            : "Search by course, title, instructor, or section number. Email alerts are free; texts are $1 per section per semester."}
        </p>
      </div>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          setSelected(null);
          setMessage("");
          if (submittedQuery === query.trim()) {
            void search.refetch();
          } else {
            setSubmittedQuery(query.trim());
          }
        }}
      >
        <div className="sm:w-44">
          <label className="mb-1 block text-sm font-semibold" htmlFor={`${inputId}-semester`}>
            Semester
          </label>
          <select
            id={`${inputId}-semester`}
            className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3"
            value={semester}
            disabled={Boolean(changingSection) || pending}
            onChange={(event) => {
              setSemester(event.target.value);
              setSubmittedQuery("");
              setSelected(null);
              setMessage("");
            }}
          >
            {(changingSection ? [changingSection.semester] : getValidSemesters()).map((term) => (
              <option key={term} value={term}>
                {formatSemester(term)}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 flex-1">
          <label className="mb-1 block text-sm font-semibold" htmlFor={`${inputId}-query`}>
            Course or section
          </label>
          <input
            id={`${inputId}-query`}
            type="search"
            className="min-h-11 w-full rounded-lg border border-gray-300 px-3"
            placeholder="e.g. LAW-532, 03172, or Constitutional Law"
            minLength={2}
            maxLength={100}
            required
            value={query}
            disabled={pending}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className={buttonClass}
          disabled={pending || search.isFetching || query.trim().length < 2}
        >
          {search.isFetching ? "Searching…" : "Search"}
        </button>
      </form>
      {search.error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          {search.error.message}{" "}
          <button type="button" className="underline" onClick={() => void search.refetch()}>
            Try again
          </button>
        </p>
      )}
      {submittedQuery && search.data && !search.isFetching && (
        <div className="space-y-3">
          <p role="status" className="text-sm text-gray-600">
            {search.data.sections.length === 0
              ? "No sections found. Try a course code, a five-digit section number, or a shorter search."
              : `${search.data.sections.length}${search.data.hasMore ? "+" : ""} sections found${search.data.hasMore ? ". Refine your search to see more specific results." : "."}`}
          </p>
          <ul className="max-h-[28rem] space-y-2 overflow-y-auto pr-1" aria-label="Section search results">
            {search.data.sections.map((result) => {
              const existing = watched?.find(
                (entry) => entry.section === result.section && entry.semester === result.semester,
              );
              const isCurrent = changingSection?.section === result.section;
              const unavailable = isCurrent || Boolean(existing);
              return (
                <li
                  key={result.id}
                  className={`rounded-xl border p-4 ${selected?.id === result.id ? "border-red-700 bg-red-50" : "border-gray-200 bg-white"}`}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {result.courseNumber} · Section {result.section}
                      </p>
                      <p className="text-sm text-gray-800">{result.courseTitle}</p>
                      <p className="mt-1 text-sm text-gray-600">
                        {[result.type, result.instructor, result.day, result.location].filter(Boolean).join(" · ")}
                      </p>
                      {result.hasDClearance && (
                        <p className="mt-1 text-xs text-amber-800">Department clearance required</p>
                      )}
                      {changingSection && existing && !isCurrent && (
                        <p className="mt-1 text-xs text-gray-600">
                          You already have alerts for this section. Choose another section to move this payment.
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className={`${buttonClass} shrink-0`}
                      disabled={unavailable || pending || (Boolean(hasUser) && !watched)}
                      onClick={() => {
                        setSelected(result);
                        setMessage("");
                      }}
                      aria-label={`Select ${result.courseNumber}, section ${result.section}`}
                      aria-pressed={selected?.id === result.id}
                    >
                      {isCurrent
                        ? "Current section"
                        : unavailable
                          ? "Already watching"
                          : selected?.id === result.id
                            ? "Selected"
                            : "Select section"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {selected && (
        <div
          className="space-y-3 rounded-xl border-2 border-gray-900 bg-gray-50 p-4"
          aria-label="Confirm selected section"
        >
          <h3 className="font-bold">
            {changingSection
              ? `Change section ${changingSection.section} to ${selected.section}?`
              : `Watch ${selected.courseNumber}, section ${selected.section}?`}
          </h3>
          <p className="text-sm">
            {selected.courseTitle} · {formatSemester(selected.semester)}
          </p>
          {changingSection && (
            <p className="text-sm">
              Your existing payment and phone number will move to this section. Alerts for section{" "}
              {changingSection.section} will stop.
            </p>
          )}
          {hasUser === undefined ? (
            <p role="status" className="text-sm">
              Checking your account…
            </p>
          ) : !hasUser ? (
            <>
              <p className="text-sm text-gray-700">Sign in with the email you use for alerts to add this section.</p>
              <SendLoginEmail />
            </>
          ) : (
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className={buttonClass}
                disabled={pending || !user || !watched || Boolean(selectedAlreadyWatched)}
                onClick={() => void save()}
              >
                {pending ? "Saving…" : changingSection ? "Move paid alerts" : "Add section"}
              </button>
              <button
                type="button"
                className="min-h-11 px-3 text-sm font-semibold underline"
                disabled={pending}
                onClick={() => setSelected(null)}
              >
                Cancel
              </button>
            </div>
          )}
          {selectedAlreadyWatched && (
            <p role="status" className="text-sm">
              You already have alerts for this section. Choose another section.
            </p>
          )}
        </div>
      )}
      {hasUser && (userQuery.error || watchedQuery.error) && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          Unable to load your current alerts.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              void userQuery.refetch();
              void watchedQuery.refetch();
            }}
          >
            Try again
          </button>
        </p>
      )}
      {message && (
        <p role="status" className="rounded-lg bg-gray-100 p-3 text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
