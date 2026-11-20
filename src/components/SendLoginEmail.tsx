import { api } from "@/utils/api";
import { useState } from "react";
import { toast } from "react-toastify";
import { useRouter } from "next/router";
import { EMAIL_ADDRESS_ERROR, emailAddressSchema } from "@/utils/emailAddress";

export const SendLoginEmail = () => {
  const { mutateAsync, isPending, data, reset } = api.user.sendLoginEmail.useMutation();
  const { data: hasUser } = api.user.hasUser.useQuery();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const parsedEmail = emailAddressSchema.safeParse(email);
  const router = useRouter();
  const submit = async () => {
    if (isPending) {
      return;
    }
    setSubmitted(true);
    if (!parsedEmail.success) {
      return;
    }
    setEmail(parsedEmail.data);
    try {
      await toast.promise(mutateAsync({ email: parsedEmail.data }), {
        pending: "Sending email...",
        success: { render: ({ data }) => `Email sent to ${data.email}` },
        error: "Error sending email. Please try again.",
      });
    } catch {
      // toast.promise displays the failure; keep the form available for retry.
    }
  };

  if (hasUser) {
    return (
      <div className={"flex flex-col gap-4 w-fit py-4"}>
        <p className={"text-gray-500 md:text-xl"}>You are already logged in</p>
        <button
          onClick={() => {
            router.push("/dashboard");
          }}
          className="inline-flex h-10 items-center justify-center rounded-md bg-gray-900 px-8 text-sm font-medium text-gray-50 shadow-sm transition-colors hover:bg-gray-900/90 disabled:pointer-events-none disabled:opacity-50"
        >
          Dashboard
        </button>
      </div>
    );
  }
  return (
    <div className={"flex flex-col gap-4 w-fit py-4"}>
      <p className={"text-gray-500 md:text-xl"}>Enter your email to view your dashboard</p>
      <input
        type="email"
        className="w-full h-12 px-4 text-sm text-gray-900 placeholder-gray-500 bg-gray-100 border-2 border-gray-100 rounded-lg"
        placeholder="Enter your email"
        maxLength={254}
        aria-invalid={!parsedEmail.success && (email.length > 0 || submitted)}
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          reset();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void submit();
          }
        }}
      />
      {!parsedEmail.success && (email.length > 0 || submitted) && (
        <p className="text-sm text-red-600" role="alert">
          {EMAIL_ADDRESS_ERROR}
        </p>
      )}
      {parsedEmail.success && parsedEmail.data !== email && (
        <p className="text-sm text-gray-600">Emails will be sent to {parsedEmail.data}</p>
      )}
      {data && (
        <p className="text-sm text-gray-600" role="status">
          Check {data.email} for your login link.
        </p>
      )}
      <button
        onClick={() => {
          void submit();
        }}
        disabled={isPending}
        className="inline-flex h-10 items-center justify-center rounded-md bg-gray-900 px-8 text-sm font-medium text-gray-50 shadow-sm transition-colors hover:bg-gray-900/90 disabled:pointer-events-none disabled:opacity-50"
      >
        Submit
      </button>
    </div>
  );
};
