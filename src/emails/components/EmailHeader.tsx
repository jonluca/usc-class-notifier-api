import { Img, Link, Section } from "react-email";
import * as React from "react";

const EmailHeader = () => {
  return (
    <Section>
      <Link href="https://usc.jonlu.ca" style={{ marginLeft: "auto", marginRight: "auto" }}>
        <Img
          src={`https://usc.jonlu.ca/logo.png`}
          width="150"
          height="100"
          alt="USC Schedule Helper"
          style={{
            marginLeft: "auto",
            marginRight: "auto",
            borderRadius: "8px",
            objectFit: "contain",
          }}
        />
      </Link>
    </Section>
  );
};

export default EmailHeader;
