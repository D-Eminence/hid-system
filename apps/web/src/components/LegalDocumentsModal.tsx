import React from 'react'
import { Modal } from './ui'

function AgreementSection({
  number,
  title,
  paragraphs,
  bullets = [],
}: {
  number: number
  title: string
  paragraphs?: string[]
  bullets?: string[]
}) {
  return (
    <section style={{ display: 'grid', gap: 10 }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: '#111827', overflowWrap: 'anywhere' }}>{number}. {title}</div>
      {paragraphs?.map(paragraph => (
        <p key={paragraph} style={{ color: '#4b5563', fontSize: 13, lineHeight: 1.7, overflowWrap: 'anywhere' }}>
          {paragraph}
        </p>
      ))}
      {bullets.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          {bullets.map(item => (
            <div key={item} style={{ color: '#4b5563', fontSize: 13, lineHeight: 1.7, overflowWrap: 'anywhere' }}>
              - {item}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function LegalDocumentsModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  return (
    <Modal open={open} onClose={onClose} title="HID Terms of Service & Privacy Policy" width={920}>
      <div style={{ display: 'grid', gap: 22 }}>
        <AgreementSection
          number={1}
          title="Introduction"
          paragraphs={[
            'Welcome to the HID (Health Identification) Platform ("HID", "we", "our", or "us"). HID provides a digital system for secure storage, management, and sharing of personal and health-related information.',
            'By accessing or using the HID Platform, you agree to be bound by these Terms of Service and Privacy Policy ("Agreement"). If you do not agree, you must not use the platform.',
          ]}
        />
        <AgreementSection
          number={2}
          title="Eligibility"
          paragraphs={['To use HID, you must:']}
          bullets={[
            'Be at least 18 years old, or',
            'Be under the supervision or consent of a parent or legal guardian.',
            'By registering, you confirm that all information provided is accurate and truthful.',
          ]}
        />
        <AgreementSection
          number={3}
          title="Account Registration & Security"
          bullets={[
            'Users must provide accurate personal information including name, phone number, and other required details.',
            'You are responsible for maintaining the confidentiality of your login credentials.',
            'You agree to notify HID immediately of any unauthorized access to your account.',
            'HID is not liable for any loss resulting from unauthorized account use.',
          ]}
        />
        <AgreementSection
          number={4}
          title="Nature of Service"
          paragraphs={['HID is a digital health identification and record management platform that:']}
          bullets={[
            'Stores personal and health-related data.',
            'Enables access and sharing of health records with authorized entities.',
            'Facilitates identity verification within healthcare systems.',
            'HID does not provide medical advice, diagnosis, or treatment. Always consult a licensed healthcare professional.',
          ]}
        />
        <AgreementSection
          number={5}
          title="User Responsibilities"
          paragraphs={['By using HID, you agree:']}
          bullets={[
            'Not to provide false or misleading information.',
            'Not to misuse, hack, reverse engineer, or disrupt the platform.',
            'Not to use the platform for unlawful or fraudulent purposes.',
            'To use the platform only for its intended healthcare-related purposes.',
          ]}
        />
        <AgreementSection
          number={6}
          title="Data Ownership"
          paragraphs={[
            'You retain ownership of your personal and health data.',
            'By using HID, you grant us a limited license to store, process, and transmit your data solely for service delivery.',
          ]}
        />
        <AgreementSection
          number={7}
          title="Data Collection"
          paragraphs={['We may collect the following information:']}
          bullets={[
            'Personal Information: Name, phone number, gender, date of birth.',
            'Health Information: Medical records, history, and related data.',
            'Technical Data: Device information, IP address, usage logs.',
          ]}
        />
        <AgreementSection
          number={8}
          title="Use of Data"
          paragraphs={['Your data is used to:']}
          bullets={[
            'Create and manage your HID account.',
            'Facilitate healthcare access and identity verification.',
            'Improve platform performance and user experience.',
            'Ensure security and prevent fraud.',
          ]}
        />
        <AgreementSection
          number={9}
          title="Data Sharing"
          paragraphs={['We may share your data only under the following conditions:']}
          bullets={[
            'With authorized healthcare providers, hospitals, or laboratories.',
            'With trusted third-party service providers supporting platform operations.',
            'When required by law or regulatory authorities.',
            'With your explicit consent.',
            'We do not sell user data.',
          ]}
        />
        <AgreementSection
          number={10}
          title="Data Security"
          paragraphs={['HID implements industry-standard security measures including:']}
          bullets={[
            'Encryption of sensitive data.',
            'Secure authentication systems.',
            'Controlled access to user information.',
            'Despite these measures, no system is 100% secure. Users acknowledge this risk.',
          ]}
        />
        <AgreementSection
          number={11}
          title="User Rights"
          paragraphs={['You have the right to:']}
          bullets={[
            'Access your personal data.',
            'Request correction of inaccurate data.',
            'Request deletion of your data (subject to legal obligations).',
            'Withdraw consent for data processing.',
            'Requests can be made via: support@healthidentitydirectory.com',
          ]}
        />
        <AgreementSection
          number={12}
          title="Data Retention"
          paragraphs={['We retain user data only as long as necessary to provide services, comply with legal obligations, and resolve disputes.']}
        />
        <AgreementSection
          number={13}
          title="Account Suspension & Termination"
          paragraphs={['HID reserves the right to:']}
          bullets={[
            'Suspend or terminate accounts that violate these terms.',
            'Remove content or restrict access where necessary.',
            'Users may also request account deletion at any time.',
          ]}
        />
        <AgreementSection
          number={14}
          title="Limitation of Liability"
          paragraphs={['To the fullest extent permitted by law:']}
          bullets={[
            'HID shall not be liable for indirect, incidental, or consequential damages.',
            'HID does not guarantee uninterrupted or error-free service.',
            'HID is not responsible for decisions made based on stored data.',
          ]}
        />
        <AgreementSection
          number={15}
          title="Indemnification"
          paragraphs={['You agree to indemnify and hold HID harmless from any claims, damages, or liabilities arising from:']}
          bullets={[
            'Your misuse of the platform.',
            'Violation of this Agreement.',
          ]}
        />
        <AgreementSection
          number={16}
          title="Third-Party Services"
          paragraphs={['HID may integrate with third-party services. We are not responsible for their practices or policies.']}
        />
        <AgreementSection
          number={17}
          title="Compliance with Regulations"
          paragraphs={['HID complies with applicable data protection laws, including:']}
          bullets={[
            'Nigeria Data Protection Regulation (NDPR).',
            'Other applicable international standards where relevant.',
          ]}
        />
        <AgreementSection
          number={18}
          title="Changes to This Agreement"
          paragraphs={['We may update this Agreement from time to time. Users will be notified of significant changes. Continued use of HID constitutes acceptance of the updated terms.']}
        />
        <AgreementSection
          number={19}
          title="Governing Law"
          paragraphs={['This Agreement shall be governed by the laws of the Federal Republic of Nigeria.']}
        />
        <AgreementSection
          number={20}
          title="Contact Information"
          paragraphs={['For questions, complaints, or data requests:']}
          bullets={[
            'Email: support@healthidentitydirectory.com',
            'Phone: +2347026717252',
            'Address: 24001, Ahmadu Bello Way, G.R.A., Ilorin, Kwara, Nigeria',
          ]}
        />
        <AgreementSection
          number={21}
          title="User Consent"
          paragraphs={['By creating an account, you confirm that:']}
          bullets={[
            'You have read and understood this Agreement.',
            'You agree to the Terms of Service and Privacy Policy.',
            'You consent to the collection and processing of your data as described.',
          ]}
        />
        <AgreementSection
          number={22}
          title="Special Category Data (Health Information)"
          paragraphs={[
            'HID processes sensitive personal data, including health-related information, which is classified as Special Category Data.',
            'By using the platform, you provide explicit consent for the collection and processing of such data strictly for:',
          ]}
          bullets={[
            'Healthcare identification and record management.',
            'Medical support services and integrations.',
            'Platform functionality and security.',
            'Processing is limited to what is necessary and proportionate.',
          ]}
        />
        <AgreementSection
          number={23}
          title="Lawful Basis for Processing (GDPR, HIPAA, NDPC Alignment)"
          paragraphs={['We process personal data under the following lawful bases:']}
          bullets={[
            'Consent - where you have given clear permission.',
            'Performance of a Contract - to provide HID services.',
            'Legal Obligation - where required by law.',
            'Vital Interests - where processing is necessary to protect life.',
            'Legitimate Interests - to improve and secure our platform.',
          ]}
        />
        <AgreementSection
          number={24}
          title="Data Subject Rights (Expanded GDPR Rights)"
          paragraphs={['In addition to previously stated rights, users have the right to:']}
          bullets={[
            'Data Portability - Receive your data in a structured, machine-readable format.',
            'Right to Restrict Processing - Limit how your data is used.',
            'Right to Object - Object to certain types of data processing.',
            'Right to Withdraw Consent - At any time without affecting prior lawful processing.',
            'Requests must be honored within a reasonable timeframe in accordance with applicable laws.',
          ]}
        />
        <AgreementSection
          number={25}
          title="Data Protection Officer (DPO)"
          paragraphs={['HID may appoint a Data Protection Officer (DPO) responsible for:']}
          bullets={[
            'Monitoring compliance with data protection laws.',
            'Advising on data privacy obligations.',
            'Serving as a point of contact for users and regulators.',
          ]}
        />
        <AgreementSection
          number={26}
          title="Data Breach Notification"
          paragraphs={['In the event of a data breach involving personal or health data:']}
          bullets={[
            'HID will notify affected users without undue delay.',
            'Where required, regulatory authorities will be informed.',
            'Appropriate mitigation steps will be taken immediately.',
          ]}
        />
        <AgreementSection
          number={27}
          title="Cross-Border Data Transfers"
          paragraphs={['Where user data is transferred outside Nigeria:']}
          bullets={[
            'Transfers will only occur to jurisdictions with adequate data protection laws, or',
            'Through approved safeguards such as contractual agreements and encryption.',
            'Users consent to such transfers where necessary for service delivery.',
          ]}
        />
        <AgreementSection
          number={28}
          title="Data Minimization & Purpose Limitation"
          paragraphs={['HID adheres to strict principles of:']}
          bullets={[
            'Data Minimization - Only collecting data that is necessary.',
            'Purpose Limitation - Using data only for specified, legitimate purposes.',
          ]}
        />
        <AgreementSection
          number={29}
          title="HIPAA-Style Health Data Protection (Security Safeguards)"
          paragraphs={['HID implements safeguards aligned with international health data protection standards, including:']}
          bullets={[
            'Administrative Safeguards - Access control policies, staff confidentiality agreements, data protection training.',
            'Technical Safeguards - End-to-end encryption where applicable, secure authentication (OTP and password protection), system monitoring, and audit logs.',
            'Physical Safeguards - Secure hosting infrastructure and controlled access to servers and systems.',
          ]}
        />
        <AgreementSection
          number={30}
          title="Role as Data Controller & Processor"
          bullets={[
            'HID acts as a Data Controller for user account data.',
            'HID may act as a Data Processor when handling data on behalf of healthcare providers.',
          ]}
        />
        <AgreementSection
          number={31}
          title="Third-Party Compliance"
          paragraphs={['All third-party partners (for example cloud providers, APIs, and healthcare institutions) are required to:']}
          bullets={[
            'Comply with applicable data protection laws.',
            'Maintain confidentiality and security of user data.',
            'Process data only as instructed by HID.',
          ]}
        />
        <AgreementSection
          number={32}
          title="Health Data Access & Audit Trails"
          bullets={[
            'All access to sensitive health data is logged and monitored.',
            'Users may request a record of access to their data where applicable.',
          ]}
        />
        <AgreementSection
          number={33}
          title="Privacy by Design & Default"
          paragraphs={['HID incorporates Privacy by Design principles, ensuring that:']}
          bullets={[
            'Data protection is embedded into system architecture.',
            'Default settings prioritize user privacy.',
            'Only necessary data is visible and accessible.',
          ]}
        />
        <AgreementSection
          number={34}
          title="Children's Data Protection"
          paragraphs={['Where users are under 18:']}
          bullets={[
            'Parental or guardian consent is required.',
            'Additional safeguards are applied to protect minors data.',
          ]}
        />
        <AgreementSection
          number={35}
          title="Retention of Health Data"
          paragraphs={['Health-related data may be retained longer than standard data where necessary for:']}
          bullets={[
            'Medical continuity.',
            'Legal and regulatory compliance.',
            'Such data will always be securely stored and protected.',
          ]}
        />
        <AgreementSection
          number={36}
          title="Disclaimer on Regulatory Scope"
          paragraphs={[
            'While HID adopts NDPC, GDPR and HIPAA-aligned best practices, users acknowledge that HID operates primarily under Nigerian law (NDPC).',
            'Full HIPAA compliance applies only where explicitly required through partnerships with covered entities.',
          ]}
        />
      </div>
    </Modal>
  )
}
