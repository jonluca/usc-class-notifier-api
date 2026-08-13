import { Button, Row, Section, Text, Link } from "react-email";
import * as React from "react";
import EmailBase from "./components/EmailBase";
import { baseDomain } from "@/constants";
import type { WatchedSection, ClassInfo } from "@app/prisma";

export interface NowWatchingEmailProps {
  verificationKey: string;
  email: string;
  sectionEntry: WatchedSection;
  classInfo: ClassInfo | null;
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

const NowWatchingEmail = ({
  classInfo,
  sectionEntry,
  verificationKey,
  isVerifiedAccount,
  showVenmoInfo,
}: NowWatchingEmailProps) => {
  const headerTitle = classInfo?.courseNumber;
  const previewText = `Watching ${headerTitle}!`;
  const accountUrl = isVerifiedAccount
    ? `${baseDomain}/dashboard?key=${verificationKey}`
    : `${baseDomain}/verify?key=${verificationKey}`;

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
            You are now watching {headerTitle ? `${headerTitle} - ` : ""}Section {sectionEntry.section}.
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
                To receive text notifications, send a venmo to{" "}
                <Link href={"https://venmo.com/u/jonluca"}>@JonLuca</Link> with just the following code in it:
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
            </>
          )}
        </Row>
      </Section>
      {showVenmoInfo && (
        <>
          <Button
            style={buttonStyle}
            href={`venmo://paycharge?txn=pay&recipients=JonLuca&amount=1&note=${sectionEntry.paidId}`}
          >
            Send Venmo (app)
          </Button>
          <Button
            style={buttonStyle}
            href={`https://account.venmo.com/pay?recipients=JonLuca&amount=1&note=${sectionEntry.paidId}`}
          >
            Send Venmo (website)
          </Button>
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

// @ts-ignore
NowWatchingEmail.PreviewProps = {
  sectionEntry: {
    id: "123",
    section: "12345",
    semester: "20243",
    notified: false,
    paidId: "12345678",
  },
  showVenmoInfo: true,
  isVerifiedAccount: false,
  email: "usc-schedule-helper@jonlu.ca",
  classInfo: {
    courseNumber: "CSCI 104",
    department: "CSCI",
    id: "123",
    name: "Data Structures",
  },
  verificationKey: "asdf",
} as NowWatchingEmailProps;

export default NowWatchingEmail;
