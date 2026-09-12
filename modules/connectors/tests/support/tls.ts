/*
 * A self-signed certificate for *.example.test, used only by this suite. The
 * call path speaks https and nothing else, so a test server has to present a
 * certificate the call trusts; the trust is added per call service through the
 * connect seam and never widens anything a deployment trusts. The key is public
 * by construction and signs nothing outside these tests.
 *
 * Regenerate with:
 *   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
 *     -keyout key.pem -out cert.pem -days 36500 -nodes -subj "/CN=example.test" \
 *     -addext "subjectAltName=DNS:example.test,DNS:*.example.test" \
 *     -addext "basicConstraints=critical,CA:TRUE"
 */

export const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBrjCCAVSgAwIBAgIUI9P2CYJ7+5R1bBKWIdvr8zZsvKcwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MCAXDTI2MDkxMTIwNTgyNVoYDzIxMjYw
ODE4MjA1ODI1WjAXMRUwEwYDVQQDDAxleGFtcGxlLnRlc3QwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAASu56d8MQXlHVpDtVzyIJ6/BIYlLl6FViyaD8ZsGqJywaTM
Cnau8gzaD70vLMGvXmt1Fjl408XjC4LoauBn5c9No3wwejAdBgNVHQ4EFgQUjve5
Povfn4f0k5rhYcua32rf768wHwYDVR0jBBgwFoAUjve5Povfn4f0k5rhYcua32rf
768wJwYDVR0RBCAwHoIMZXhhbXBsZS50ZXN0gg4qLmV4YW1wbGUudGVzdDAPBgNV
HRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIHLYy1QeXmDY/BQJ1M8CCC4g
kNujobmb10whkgGnCVucAiEAtf9uil3P1CA5DYCeK5aZRDGNQU2PFiILRV2e95aN
ijk=
-----END CERTIFICATE-----
`;

export const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQge9f64dwBvj7/1mHi
+o5EgzCziIzFB5J9QCpCZuNibgOhRANCAASu56d8MQXlHVpDtVzyIJ6/BIYlLl6F
ViyaD8ZsGqJywaTMCnau8gzaD70vLMGvXmt1Fjl408XjC4LoauBn5c9N
-----END PRIVATE KEY-----
`;
