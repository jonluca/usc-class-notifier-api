import { Button, Row, Section, Text } from "react-email";
import * as React from "react";
import EmailBase from "./components/EmailBase";
import { baseDomain } from "@/constants";
import type { PreviewableEmail } from "@/emails/utilities/previewableEmail";

interface VerificationEmailProps {
  verificationKey: string;
  isVerifiedAlready?: boolean;
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

const VerificationEmail: PreviewableEmail<VerificationEmailProps> = ({ isVerifiedAlready, verificationKey }) => {
  const previewText = isVerifiedAlready ? "Sign in" : "🎉 Welcome to the USC Schedule Helper!";
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
            {isVerifiedAlready
              ? "You're all set to start using the USC Schedule Helper. Click the button below to sign in."
              : "Verify your email to begin using the USC Schedule Helper."}
          </Text>
        </Row>
      </Section>
      <Button style={buttonStyle} href={`${baseDomain}/verify?key=${verificationKey}`}>
        {isVerifiedAlready ? "Sign in" : "Verify"}
      </Button>
    </EmailBase>
  );
};

VerificationEmail.PreviewProps = { isVerifiedAlready: true, verificationKey: "asdf" };

export default VerificationEmail;
