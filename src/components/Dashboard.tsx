import { api } from "@/utils/api";
import { LinearProgress, TextField, Typography } from "@mui/material";
import React, { useMemo, useState } from "react";
import type { RouterOutputs } from "@/server/api";
import type { AgGridReactProps } from "ag-grid-react";
import { AgGridReact } from "ag-grid-react";
import { ClientSideRowModelModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { getValidSemesters } from "@/utils/semester";
import { SettingEntry } from "@/components/SettingsEntry";
import { toast } from "react-toastify";
import PencilIcon from "@mui/icons-material/Edit";
import Close from "@mui/icons-material/Close";
import Save from "@mui/icons-material/Check";
import LinkIcon from "@mui/icons-material/Link";
import Cookies from "js-cookie";
import { cookieKey } from "@/server/auth";
import { buildPaymentHelpUrl, buildVenmoPaymentUrl, formatSemester } from "@/utils/venmoPayment";
import { VenmoPaymentPanel } from "@/components/VenmoPaymentPanel";
import { formatPhoneNumberForDisplay, parsePhoneNumber, PHONE_NUMBER_ERROR } from "@/utils/phoneNumber";
ModuleRegistry.registerModules([ClientSideRowModelModule]);
type Section = RouterOutputs["user"]["getWatchedClasses"][number];
type ColDef = AgGridReactProps<Section>["columnDefs"];
const defaultColDef: NonNullable<ColDef>[number] = {
  width: 130,
  sortable: true,
  filter: true,
};

const NotifyButton = ({ data }: { data: Section }) => {
  const utils = api.useUtils();
  const { mutateAsync, isPending } = api.user.continueReceivingNotificationsForSection.useMutation();

  if (!data || !data.notified) {
    return null;
  }
  // check if it's in the past
  const semester = data.semester;
  if (semester) {
    const year = semester.slice(0, 4);
    const currentYear = new Date().getFullYear();
    // we could be smarter and do per semester but this is fine
    if (parseInt(year) < currentYear) {
      return null;
    }
  }
  const submit = async () => {
    await toast.promise(mutateAsync({ id: data.id }), {
      pending: "Re-notifying",
      success: "Re-notified",
      error: "Failed to re-notify",
    });
    await utils.user.invalidate();
  };

  return (
    <button
      className="inline-flex py-1 items-center justify-center rounded-md bg-gray-900 px-3 text-sm font-medium text-gray-50 shadow-sm transition-colors hover:bg-gray-900/90 disabled:pointer-events-none disabled:opacity-50"
      disabled={isPending}
      onClick={submit}
    >
      Re-Notify
    </button>
  );
};
const iconStyle = { fontSize: 14, cursor: "pointer" };

const PhoneOverride = ({ data }: { data: Section }) => {
  const [isEdit, setIsEdit] = useState(false);
  const [phone, setPhone] = useState(data.phoneOverride || "");
  const { mutateAsync } = api.user.changePhoneNumberForSection.useMutation();
  const utils = api.useUtils();

  if (isEdit) {
    return (
      <span className={"flex items-center gap-2"}>
        <Close sx={iconStyle} onClick={() => setIsEdit(false)} />
        <Save
          sx={iconStyle}
          onClick={async () => {
            const parsedPhone = parsePhoneNumber(phone);
            if (!parsedPhone) {
              toast.error(PHONE_NUMBER_ERROR);
              return;
            }
            await toast.promise(mutateAsync({ id: data.id, phoneNumber: parsedPhone }), {
              pending: "Saving",
              success: "Saved",
              error: "Failed to save",
            });
            await utils.user.invalidate();
            setIsEdit(false);
          }}
        />
        <input
          type="tel"
          aria-label={`Phone number for section ${data.section}`}
          autoComplete="tel"
          inputMode="tel"
          maxLength={35}
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
          }}
        />
      </span>
    );
  }
  return (
    <span className={"flex h-full gap-2 items-center"}>
      {data.phoneOverride ? formatPhoneNumberForDisplay(data.phoneOverride) : ""}
      <PencilIcon
        sx={iconStyle}
        onClick={() => {
          setPhone(data.phoneOverride || "");
          setIsEdit(true);
        }}
      />
    </span>
  );
};

const isCurrentPaymentSemester = (semester: string) => getValidSemesters().includes(semester);
const hasValidPaymentNote = (paidId: string) => /^\d{8}$/.test(paidId);

const PaymentNoteCell = ({ data }: { data: Section }) => {
  if (!data) {
    return null;
  }

  const isCurrentSemester = isCurrentPaymentSemester(data.semester);
  const validPaymentNote = hasValidPaymentNote(data.paidId);
  const helpUrl = buildPaymentHelpUrl({
    paidId: data.paidId,
    section: data.section,
    semester: data.semester,
    courseNumber: data.ClassInfo?.courseNumber,
  });

  return (
    <span className="flex h-full items-center gap-2">
      <span className="font-mono text-xs font-semibold tracking-wide">
        {validPaymentNote ? data.paidId : "Unavailable"}
      </span>
      {data.isPaid ? (
        <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-bold text-green-800">Paid</span>
      ) : isCurrentSemester && validPaymentNote ? (
        <a
          className="inline-flex items-center gap-1 rounded-full bg-gray-900 px-2 py-0.5 text-[11px] font-bold text-white hover:bg-gray-700"
          href={buildVenmoPaymentUrl(data.paidId)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Pay $1 for section ${data.section}`}
        >
          Pay $1
          <LinkIcon sx={{ fontSize: 12 }} />
        </a>
      ) : isCurrentSemester ? (
        <a
          className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900 underline"
          href={helpUrl}
          aria-label={`Get payment help for section ${data.section}`}
        >
          Get help
        </a>
      ) : (
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-bold text-gray-500">Expired</span>
      )}
    </span>
  );
};

const LegacyPaymentHelpCard = ({ data }: { data: Section }) => {
  const helpUrl = buildPaymentHelpUrl({
    paidId: data.paidId,
    section: data.section,
    semester: data.semester,
    courseNumber: data.ClassInfo?.courseNumber,
  });

  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-2xl border border-amber-300 bg-white p-4 text-gray-900 shadow-sm">
      <div>
        <p className="text-sm font-bold text-amber-900">Payment note needs to be updated</p>
        <p className="text-xs text-gray-600">
          {data.ClassInfo?.courseNumber ? `${data.ClassInfo.courseNumber} · ` : ""}Section {data.section} ·{` `}
          {formatSemester(data.semester)}
        </p>
      </div>
      <p className="text-sm leading-6">
        This section has an older payment reference that Venmo cannot safely match. Do not send a payment using the old
        reference.
      </p>
      <a
        className="inline-flex min-h-11 items-center justify-center rounded-lg bg-gray-900 px-4 py-2.5 text-center font-bold text-white hover:bg-gray-700"
        href={helpUrl}
      >
        Recover a payment or get an updated note
      </a>
    </article>
  );
};

const columns = [
  // { headerName: "Department", field: "ClassInfo.department" },
  { headerName: "Section", field: "section", width: 100 },
  { headerName: "Course", field: "ClassInfo.courseNumber", width: 120 },
  { headerName: "Semester", field: "semester", initialSort: "desc", width: 137 },
  { headerName: "Notified", field: "notified", width: 90, filter: false },
  { headerName: "Payment note", field: "paidId", width: 220, cellRenderer: PaymentNoteCell },
  { headerName: "Phone", field: "phoneOverride", cellRenderer: PhoneOverride, width: 160 },
  { headerName: "Paid", field: "isPaid", width: 80, filter: false },
  { headerName: "Notify", field: "notified", cellRenderer: NotifyButton },
] satisfies NonNullable<ColDef>;

const EditPhoneGlobal = () => {
  const { data: userInfo } = api.user.getUserInfo.useQuery();

  const [isEdit, setIsEdit] = useState(false);
  const [phone, setPhone] = useState(userInfo?.phone || "");
  const { mutateAsync } = api.user.changePhoneNumberForAccount.useMutation();
  const utils = api.useUtils();

  if (isEdit) {
    return (
      <span className={"flex items-center gap-2"}>
        <Close sx={iconStyle} onClick={() => setIsEdit(false)} />
        <Save
          sx={iconStyle}
          onClick={async () => {
            const parsedPhone = parsePhoneNumber(phone);
            if (!parsedPhone) {
              toast.error(PHONE_NUMBER_ERROR);
              return;
            }
            await toast.promise(mutateAsync({ phoneNumber: parsedPhone }), {
              pending: "Saving",
              success: "Saved",
              error: "Failed to save",
            });
            await utils.user.invalidate();
            setIsEdit(false);
          }}
        />
        <input
          type="tel"
          aria-label="Account phone number"
          autoComplete="tel"
          inputMode="tel"
          maxLength={35}
          value={phone}
          className="w-full h-12 px-4 text-sm text-gray-900 placeholder-gray-500 bg-gray-100 border-2 border-gray-100 rounded-lg"
          onChange={(e) => {
            setPhone(e.target.value);
          }}
        />
      </span>
    );
  }

  if (!userInfo) {
    return null;
  }
  return (
    <span className={"flex h-full gap-2 items-center"}>
      {userInfo.phone ? formatPhoneNumberForDisplay(userInfo.phone) : ""}
      <PencilIcon
        sx={iconStyle}
        onClick={() => {
          setPhone(userInfo.phone || "");
          setIsEdit(true);
        }}
      />
    </span>
  );
};

const AdminEmailSetter = () => {
  const [email, setEmail] = useState("");
  const { mutateAsync } = api.admin.getUserKey.useMutation();
  const utils = api.useUtils();

  return (
    <div className="flex flex-col items-center gap-4 bg-gray-100 rounded-xl p-2 w-[400px]">
      <Typography variant="body2" className="font-bold text-neutral-400 text-xs ml-4 -mb-3 w-full">
        Email
      </Typography>
      <TextField
        className={`flex w-full bg-white rounded-xl`}
        size="small"
        variant="outlined"
        sx={{
          ".MuiOutlinedInput-notchedOutline": { border: 0 },
          ".MuiOutlinedInput-root": { paddingY: 0.3 },
          ".MuiInputBase-input": { fontSize: 16, fontWeight: "bold" },
        }}
        placeholder={"Email"}
        onChange={(e) => {
          // Ensure the length isn't over 35 characters
          if (e.target.value.length > 35) {
            return;
          }
          setEmail(e.target.value);
        }}
        onKeyDown={async (e) => {
          // Handle enter key
          if (e.key === "Enter") {
            const data = await mutateAsync({ email });
            if (!data) {
              alert("No user found");
              return;
            }
            // set document.cookie of key to users verification key and refresh all

            Cookies.set(cookieKey, data.verificationKey, {
              path: "/",
            });
            await utils.invalidate();

            return;
          }
        }}
        value={email}
      />
    </div>
  );
};
export default function Dashboard({
  isAdmin,
  didSucceedInWatchingSection,
  section,
}: {
  didSucceedInWatchingSection?: boolean;
  section?: string;
  isAdmin?: boolean;
}) {
  const { data, isLoading } = api.user.getWatchedClasses.useQuery();
  const { data: userInfo } = api.user.getUserInfo.useQuery();
  const [showOldSemesters, setShowOldSemesters] = useState(false);
  const { mutateAsync, isPending } = api.user.setAccountLevelPhoneToAllSections.useMutation();
  const utils = api.useUtils();
  const currentSemesters = useMemo(() => new Set(getValidSemesters()), []);

  const setAccountLevelPhoneToAllSections = async () => {
    await toast.promise(mutateAsync(), {
      pending: "Setting phone number",
      success: "Set phone number",
      error: "Failed to set phone number",
    });
    await utils.user.invalidate();
  };
  const filteredData = useMemo(() => {
    if (showOldSemesters) {
      return data || [];
    }
    return data?.filter((section) => currentSemesters.has(section.semester)) || [];
  }, [currentSemesters, data, showOldSemesters]);
  const unpaidCurrentSections = useMemo(
    () =>
      data?.filter((watchedSection) => !watchedSection.isPaid && currentSemesters.has(watchedSection.semester)) || [],
    [currentSemesters, data],
  );

  const matchingSection = data?.find((s) => s.id === section);
  return (
    <div className={"flex flex-col h-full py-4 gap-4"}>
      {isLoading && <LinearProgress />}
      {isAdmin && <AdminEmailSetter />}
      {userInfo && <h1>Welcome, {userInfo.email}</h1>}
      {section && (
        <>
          {didSucceedInWatchingSection ? (
            <div className={"flex flex-col bg-green-200 rounded-lg p-1 w-fit"}>
              <div className="space-y-2 ">
                <h1 className="text-3xl font-bold">Success</h1>
                <p className="max-w-md">
                  You will continue receiving notifications for{" "}
                  {matchingSection?.ClassInfo?.courseNumber || "this class"}
                </p>
              </div>
            </div>
          ) : (
            <div className={"flex flex-col justify-center bg-red-200 rounded-lg p-1 w-fit"}>
              <div className={"text-xl"}>Error</div>
              There was an issue watching section - please reach out to usc-schedule-helper@jonlu.ca for more help:{" "}
              {section}
            </div>
          )}
        </>
      )}
      {userInfo && (
        <div className={"flex items-center gap-2"}>
          <div className={"flex items-center gap-2"}>
            Phone: <EditPhoneGlobal />
          </div>
          {userInfo.phone && (
            <button
              className="inline-flex py-1 items-center justify-center rounded-md bg-gray-900 px-3 text-sm font-medium text-gray-50 shadow-sm transition-colors hover:bg-gray-900/90 disabled:pointer-events-none disabled:opacity-50"
              disabled={isPending}
              onClick={setAccountLevelPhoneToAllSections}
            >
              Use for all classes
            </button>
          )}
        </div>
      )}
      <div className={"flex"}>
        <SettingEntry
          checked={showOldSemesters}
          onChange={() => setShowOldSemesters(!showOldSemesters)}
          title="Show Old Semesters"
          subtitle="Show classes from previous semesters"
        />
      </div>

      {unpaidCurrentSections.length > 0 && (
        <section
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:p-5"
          aria-labelledby="text-payment-heading"
        >
          <div className="mb-4 max-w-3xl space-y-1">
            <p className="text-xs font-bold uppercase tracking-wider text-[#990000]">Optional text notifications</p>
            <h2 id="text-payment-heading" className="text-2xl font-bold tracking-tight text-gray-950">
              Activate texts for each section
            </h2>
            <p className="text-sm leading-6 text-gray-700">
              Email availability alerts are free. Text alerts cost $1 per section per semester, and each section has its
              own required 8-digit payment note.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {unpaidCurrentSections.map((watchedSection) => {
              const hasPhoneNumber = Boolean(
                parsePhoneNumber(watchedSection.phoneOverride || "") || parsePhoneNumber(userInfo?.phone || ""),
              );

              return (
                <div key={watchedSection.id} className="flex min-w-0 flex-col gap-2">
                  {!hasPhoneNumber && (
                    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
                      Add your phone number above before paying so this section can send text alerts.
                    </p>
                  )}
                  {hasValidPaymentNote(watchedSection.paidId) ? (
                    <VenmoPaymentPanel
                      courseNumber={watchedSection.ClassInfo?.courseNumber}
                      paidId={watchedSection.paidId}
                      section={watchedSection.section}
                      semester={watchedSection.semester}
                      showQr
                    />
                  ) : (
                    <LegacyPaymentHelpCard data={watchedSection} />
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Grid goes here */}
      {!isLoading && (
        <div style={{ height: "600px", width: "100%" }}>
          <AgGridReact<Section>
            key={`${userInfo?.id}`}
            theme={themeQuartz}
            rowData={filteredData}
            columnDefs={columns}
            defaultColDef={defaultColDef}
          />
        </div>
      )}
    </div>
  );
}
