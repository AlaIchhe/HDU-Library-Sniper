use super::*;

impl AuthService {
    pub(crate) async fn follow(
        &self,
        url: &str,
        method: Method,
        headers: Vec<(String, String)>,
        form: Option<Vec<(String, String)>>,
    ) -> Result<Response, AuthError> {
        let mut current = Url::parse(url).map_err(|error| AuthError::Invalid(error.to_string()))?;
        let mut current_method = method;
        let mut current_form = form;
        for _ in 0..10 {
            let cookie = self
                .auth_jar
                .lock()
                .expect("auth jar poisoned")
                .header_for(current.as_str());
            let mut request = self
                .auth_http
                .request(current_method.clone(), current.clone());
            for (key, value) in &headers {
                request = request.header(key, value);
            }
            if !cookie.is_empty() {
                request = request.header(COOKIE, cookie);
            }
            if let Some(form) = current_form.as_ref() {
                request = request.form(form);
            }
            let response = request.send().await.map_err(|error| {
                if error.is_timeout() {
                    HduError::RequestTimeout
                } else {
                    HduError::Network(error.to_string())
                }
            })?;
            self.auth_jar
                .lock()
                .expect("auth jar poisoned")
                .merge_headers(response.headers(), current.as_str());
            let status = response.status();
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let Some(location) = location else {
                return Ok(response);
            };
            if !matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            current = current
                .join(&location)
                .map_err(|error| AuthError::Invalid(error.to_string()))?;
            if status == reqwest::StatusCode::SEE_OTHER
                || (status == reqwest::StatusCode::FOUND && current_method == Method::POST)
            {
                current_method = Method::GET;
                current_form = None;
            }
        }
        Err(AuthError::Invalid("SSO 重定向次数过多".into()))
    }

    pub(crate) async fn login_password_inner(
        &self,
        student_id: &str,
        password: &str,
    ) -> Result<LoginResult, String> {
        let response = self
            .follow(
                &self.endpoints.login_entry,
                Method::GET,
                vec![(HEADER_USER_AGENT.to_string(), USER_AGENT.to_string())],
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Ok(LoginResult {
                success: false,
                message: format!("登录入口不可用: {}", response.status()),
            });
        }
        let final_url = response.url().clone();
        let html = response.text().await.map_err(|error| error.to_string())?;
        let key = first_capture(
            &html,
            &[
                r#"id=["']login-croypto["'][^>]*>([^<]+)<"#,
                r#"id=["']login-croypto["'][^>]*value=["']([^"']+)"#,
            ],
        )
        .ok_or_else(|| "SSO 页面缺少登录参数".to_string())?;
        let execution = first_capture(
            &html,
            &[
                r#"id=["']login-page-flowkey["'][^>]*>([^<]+)<"#,
                r#"id=["']login-page-flowkey["'][^>]*value=["']([^"']+)"#,
                r#"name=["']execution["'][^>]*value=["']([^"']+)"#,
            ],
        )
        .ok_or_else(|| "SSO 页面缺少登录参数".to_string())?;
        let action = first_capture(
            &html,
            &[r#"<form[^>]+id=["']normalLoginForm["'][^>]+action=["']([^"']+)"#],
        )
        .unwrap_or_else(|| "/login".to_string());
        let action_url = final_url.join(&action).map_err(|error| error.to_string())?;
        let encrypted = encrypt_password(&key, password)?;
        let captcha = encrypt_password(&key, "{}")?;
        let form = vec![
            ("username".into(), student_id.to_string()),
            ("type".into(), "UsernamePassword".into()),
            ("_eventId".into(), "submit".into()),
            ("execution".into(), execution),
            ("croypto".into(), key),
            ("password".into(), encrypted),
            ("captcha_payload".into(), captcha),
        ];
        let response = self
            .follow(
                action_url.as_str(),
                Method::POST,
                vec![(HEADER_USER_AGENT.to_string(), USER_AGENT.to_string())],
                Some(form),
            )
            .await
            .map_err(|error| error.to_string())?;
        if response.url().as_str().starts_with(&self.endpoints.sso) {
            return Ok(LoginResult {
                success: false,
                message: "SSO 登录失败，请核对凭据或稍后重试".into(),
            });
        }
        self.sync_cookies_to_client();
        if !self.client.validate().await || self.client.uid().is_empty() {
            return Ok(LoginResult {
                success: false,
                message: "Cookie 无效或登录态未生效".into(),
            });
        }
        *self.openid.lock().expect("openid poisoned") = None;
        self.persist().await.map_err(|error| error.to_string())?;
        let name = self.client.name();
        Ok(LoginResult {
            success: true,
            message: if name.is_empty() {
                "认证成功".into()
            } else {
                format!("认证成功：{name}")
            },
        })
    }

    pub async fn login_password(&self, student_id: &str, password: &str) -> LoginResult {
        if student_id.trim().is_empty() || password.is_empty() {
            return LoginResult {
                success: false,
                message: "请输入学号和密码".into(),
            };
        }
        if let Some(remaining) = self.login_blocked() {
            return LoginResult {
                success: false,
                message: format!("尝试次数过多，请 {remaining} 秒后再试"),
            };
        }
        *self.credentials.lock().expect("credentials poisoned") = Some(Credentials {
            student_id: student_id.to_string(),
            password: password.to_string(),
        });
        let result = match self.login_password_inner(student_id, password).await {
            Ok(result) => result,
            Err(error) => LoginResult {
                success: false,
                message: format!("登录请求失败：{error}"),
            },
        };
        self.note_login(result.success);
        result
    }

    pub(crate) async fn exchange_openid(&self, openid: &str) -> Result<(), HduError> {
        let url = format!(
            "{}/content/index/startUp/openid/{}/",
            self.endpoints.library,
            urlencoding::encode(openid)
        );
        let response = self
            .follow(
                &url,
                Method::GET,
                vec![
                    (HEADER_USER_AGENT.to_string(), OPENID_USER_AGENT.to_string()),
                    (
                        ACCEPT.to_string(),
                        "text/html,application/xhtml+xml,*/*".to_string(),
                    ),
                ],
                None,
            )
            .await
            .map_err(|error| match error {
                AuthError::Hdu(error) => error,
                other => HduError::Library(other.to_string()),
            })?;
        if response.url().as_str().starts_with(&self.endpoints.sso) {
            return Err(HduError::Library(
                "openid 无效：被重定向到统一认证登录".into(),
            ));
        }
        if !response.status().is_success() {
            return Err(HduError::Http(response.status().as_u16()));
        }
        self.sync_cookies_to_client();
        if !self.client.validate().await || self.client.uid().is_empty() {
            return Err(HduError::Library("openid 无效或登录态未生效".into()));
        }
        Ok(())
    }

    pub async fn login_with_openid(&self, raw: &str) -> LoginResult {
        let openid = extract_openid(raw);
        if openid.is_empty() {
            return LoginResult {
                success: false,
                message: "请输入有效的 openid 或微信端登录链接".into(),
            };
        }
        let snapshot = SessionSnapshot {
            cookies: self.client.jar_snapshot().all(),
            uid: self.client.uid(),
            name: self.client.name(),
            credentials: self
                .credentials
                .lock()
                .expect("credentials poisoned")
                .clone(),
            openid: self.openid.lock().expect("openid poisoned").clone(),
        };
        self.clear_state();
        *self.credentials.lock().expect("credentials poisoned") = None;
        let result = self.exchange_openid(&openid).await;
        match result {
            Ok(()) => {
                *self.openid.lock().expect("openid poisoned") = Some(openid);
                *self.credentials.lock().expect("credentials poisoned") = None;
                if let Err(error) = self.persist().await {
                    return LoginResult {
                        success: false,
                        message: format!("openid 登录失败：{error}"),
                    };
                }
                let name = self.client.name();
                LoginResult {
                    success: true,
                    message: if name.is_empty() {
                        "认证成功".into()
                    } else {
                        format!("认证成功：{name}")
                    },
                }
            }
            Err(error) => {
                self.rollback(snapshot).await;
                LoginResult {
                    success: false,
                    message: format!("openid 登录失败：{error}"),
                }
            }
        }
    }

    pub(crate) async fn ensure_sso_page(&self) -> Result<Url, AuthError> {
        let response = self
            .follow(
                &self.endpoints.sso_login_page,
                Method::GET,
                vec![(HEADER_USER_AGENT.to_string(), USER_AGENT.to_string())],
                None,
            )
            .await?;
        if !response.status().is_success() {
            return Err(AuthError::Invalid(format!(
                "SSO 页面不可用: {}",
                response.status()
            )));
        }
        let url = response.url().clone();
        let _ = response.text().await;
        let _ = self.load_csrf().await;
        Ok(url)
    }

    async fn load_csrf(&self) -> Result<(), AuthError> {
        let response = self
            .follow(
                &self.endpoints.sso_csrf_script,
                Method::GET,
                vec![(HEADER_USER_AGENT.to_string(), USER_AGENT.to_string())],
                None,
            )
            .await?;
        if !response.status().is_success() {
            return Ok(());
        }
        let script = response
            .text()
            .await
            .map_err(|error| AuthError::Invalid(error.to_string()))?;
        let key = first_capture(
            &script,
            &[
                r#"Csrf-Key['"]?\s*,\s*['"]([^'"]+)"#,
                r#"Csrf-Key['"]?\s*[:=]\s*['"]([^'"]+)"#,
            ],
        );
        let value = first_capture(
            &script,
            &[
                r#"Csrf-Value['"]?\s*,\s*['"]([^'"]+)"#,
                r#"Csrf-Value['"]?\s*[:=]\s*['"]([^'"]+)"#,
            ],
        );
        if let (Some(key), Some(value)) = (key, value) {
            *self.csrf.lock().expect("csrf poisoned") = Csrf { key, value };
        }
        Ok(())
    }

    pub(crate) fn sso_headers(&self, referer: &str) -> Vec<(String, String)> {
        let csrf = self.csrf.lock().expect("csrf poisoned").clone();
        vec![
            ("Accept".into(), "application/json, text/plain, */*".into()),
            (HEADER_USER_AGENT.to_string(), USER_AGENT.into()),
            ("Origin".into(), self.endpoints.sso.clone()),
            ("Referer".into(), referer.to_string()),
            ("Csrf-Key".into(), csrf.key),
            ("Csrf-Value".into(), csrf.value),
        ]
    }

    pub(crate) async fn read_sso_json(&self, response: Response) -> Result<Value, AuthError> {
        let body: Value = response
            .json()
            .await
            .map_err(|_| AuthError::Invalid("SSO 接口返回异常".into()))?;
        let code = body.get("code").and_then(Value::as_i64).or_else(|| {
            body.get("code")
                .and_then(Value::as_str)
                .and_then(|value| value.parse().ok())
        });
        if code != Some(200) {
            return Err(AuthError::Invalid(
                body.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("SSO 接口返回异常")
                    .to_string(),
            ));
        }
        Ok(body)
    }
}

fn first_capture(html: &str, patterns: &[&str]) -> Option<String> {
    for pattern in patterns {
        let regex = Regex::new(pattern).ok()?;
        if let Some(capture) = regex.captures(html) {
            if let Some(value) = capture
                .get(1)
                .map(|value| value.as_str().trim().to_string())
                .filter(|value| !value.is_empty())
            {
                return Some(value);
            }
        }
    }
    None
}
