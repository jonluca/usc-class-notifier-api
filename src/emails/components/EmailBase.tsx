import { Body, Container, Head, Html, Preview } from "react-email";
import * as React from "react";
import EmailFooter from "./EmailFooter";
import EmailHeader from "./EmailHeader";

const EmailBase = ({
  previewText,
  children,
  hideHeader,
}: {
  previewText: string;
  children: React.ReactNode;
  hideHeader?: boolean;
}) => {
  return (
    <Html>
      <Preview>{previewText}</Preview>
      <Head />
      <Body
        style={{
          backgroundColor: "#f3f4f6",
          marginTop: "auto",
          marginBottom: "auto",
          marginLeft: "auto",
          marginRight: "auto",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          padding: "8px",
          borderRadius: "24px",
        }}
      >
        <Container
          style={{
            borderRadius: "24px",
            backgroundColor: "#ffffff",
            marginLeft: "auto",
            marginRight: "auto",
            marginTop: "32px",
            padding: "20px",
            maxWidth: "465px",
          }}
        >
          {!hideHeader && <EmailHeader />}
          {children}
        </Container>
        <EmailFooter />
      </Body>
    </Html>
  );
};

export default EmailBase;
