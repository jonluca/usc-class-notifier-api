import { Button, Row, Section, Text, Link } from "react-email";
import * as React from "react";
import EmailBase from "./components/EmailBase";
import { baseDomain } from "@/constants";
import { buildPaymentHelpUrl, buildVenmoPaymentUrl, formatSemester } from "@/utils/venmoPayment";
import type { WatchedSection, ClassInfo } from "@app/prisma";
import type { PreviewableEmail } from "@/emails/utilities/previewableEmail";

export interface NowWatchingEmailProps {
  verificationKey: string;
  email: string;
  sectionEntry: Pick<WatchedSection, "section" | "semester" | "paidId">;
  classInfo: Pick<ClassInfo, "courseNumber"> | null;
  isVerifiedAccount: boolean;
  showVenmoInfo?: boolean;
}

const buttonStyle = {
  backgroundColor: "#000000",
  borderRadius: "12px",
  color: "#ffffff",
  fontWeight: "bold" as const,
  textDecoration: "none" as const,
  textAlign: "center" as const,
  paddingTop: "8px",
  paddingBottom: "8px",
  width: "100%",
  fontSize: "18px",
  marginTop: "16px",
  display: "block",
};

const NowWatchingEmail: PreviewableEmail<NowWatchingEmailProps> = ({
  classInfo,
  sectionEntry,
  verificationKey,
  isVerifiedAccount,
  showVenmoInfo,
}: NowWatchingEmailProps) => {
  const courseNumber = classInfo?.courseNumber;
  const semester = formatSemester(sectionEntry.semester);
  const watchDetails = `${courseNumber ? `${courseNumber} · ` : ""}Section ${sectionEntry.section} · ${semester}`;
  const previewText = `Watching ${watchDetails}`;
  const accountUrl = isVerifiedAccount
    ? `${baseDomain}/dashboard?key=${verificationKey}`
    : `${baseDomain}/verify?key=${verificationKey}`;
  const paymentUrl = buildVenmoPaymentUrl(sectionEntry.paidId);
  const paymentHelpUrl = buildPaymentHelpUrl({
    paidId: sectionEntry.paidId,
    section: sectionEntry.section,
    semester: sectionEntry.semester,
    courseNumber,
  });

  return (
    <EmailBase previewText={previewText}>
      <Text
        style={{
          color: "#000000",
          fontSize: "24px",
          fontWeight: "bold",
          textAlign: "center",
          padding: 0,
          marginTop: "24px",
          marginLeft: 0,
          marginRight: 0,
        }}
      >
        {previewText}
      </Text>
      <Section style={{ marginLeft: "auto", marginRight: "auto", marginTop: "24px" }}>
        <Row>
          <Text style={{ color: "#000000", fontSize: "16px", paddingLeft: "8px", paddingRight: "8px", margin: 0 }}>
            You are now watching {courseNumber ? `${courseNumber}, ` : ""}Section {sectionEntry.section} for {semester}.
          </Text>
          {showVenmoInfo && (
            <>
              <Text
                style={{
                  color: "#000000",
                  fontSize: "16px",
                  paddingLeft: "8px",
                  paddingRight: "8px",
                  paddingTop: "16px",
                  margin: 0,
                }}
              >
                Text alerts are optional and cost exactly $1.00 for this one section. Venmo must receive the required
                eight-digit payment note below so the payment can be matched automatically.
              </Text>
              <Text
                style={{
                  color: "#000000",
                  fontSize: "14px",
                  padding: "16px 8px 0",
                  margin: 0,
                  fontWeight: "bold",
                  textAlign: "center",
                }}
              >
                Required Venmo payment note
              </Text>
              <Text
                style={{
                  color: "#000000",
                  fontSize: "24px",
                  padding: "8px",
                  margin: 0,
                  fontWeight: "bold",
                  width: "100%",
                  textAlign: "center",
                }}
              >
                {sectionEntry.paidId}
              </Text>
              <Text
                style={{
                  color: "#000000",
                  fontSize: "15px",
                  padding: "0 8px",
                  margin: 0,
                  textAlign: "center",
                }}
              >
                Send these eight digits exactly as shown. Do not replace them with a course name, phone number, or “text
                notifications.”
              </Text>
            </>
          )}
        </Row>
      </Section>
      {showVenmoInfo && (
        <>
          <Button style={buttonStyle} href={paymentUrl}>
            Pay exactly $1.00 in Venmo — note prefilled
          </Button>
          <Text style={{ color: "#000000", fontSize: "15px", padding: "8px", margin: "12px 0 0" }}>
            Send one separate $1.00 payment for each section. Payment processing can take up to 20 minutes. If Venmo
            asks you to verify the recipient, that verification value is not your payment note.
          </Text>
          <Text style={{ color: "#000000", fontSize: "15px", padding: "0 8px", margin: 0 }}>
            Already paid with the wrong or missing note? Do not pay again.{" "}
            <Link href={paymentHelpUrl}>Get payment help</Link>.
          </Text>
        </>
      )}
      {!isVerifiedAccount && (
        <Text style={{ color: "#000000", fontSize: "16px", padding: "8px", marginTop: "16px" }}>
          Verify your email address to activate availability notifications for this section.
        </Text>
      )}
      <Button style={buttonStyle} href={accountUrl}>
        {isVerifiedAccount ? "View Dashboard" : "Verify Email & View Dashboard"}
      </Button>
    </EmailBase>
  );
};

NowWatchingEmail.PreviewProps = {
  sectionEntry: {
    section: "12345",
    semester: "20243",
    paidId: "12345678",
  },
  showVenmoInfo: true,
  isVerifiedAccount: false,
  email: "usc-schedule-helper@jonlu.ca",
  classInfo: {
    courseNumber: "CSCI 104",
  },
  verificationKey: "asdf",
};

export default NowWatchingEmail;
