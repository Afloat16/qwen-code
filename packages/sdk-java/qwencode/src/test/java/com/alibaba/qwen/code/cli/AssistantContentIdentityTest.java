package com.alibaba.qwen.code.cli;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.TextAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantUsage;
import com.alibaba.qwen.code.cli.protocol.message.assistant.SDKPartialAssistantMessage;
import com.alibaba.qwen.code.cli.session.Session;
import com.alibaba.qwen.code.cli.session.event.consumers.AssistantContentSimpleConsumers;
import com.alibaba.qwen.code.cli.transport.TransportOptions;
import com.alibaba.qwen.code.cli.utils.Timeout;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AssistantContentIdentityTest {
    private static final String FIRST_ID = "00000000-0000-4000-8000-000000000001";
    private static final String SECOND_ID = "00000000-0000-4000-8000-000000000002";
    private static final String THIRD_ID = "00000000-0000-4000-8000-000000000003";

    @TempDir
    Path temporary;

    @ParameterizedTest
    @CsvSource({"false,true", "true,true", "false,false", "true,false"})
    @DisabledOnOs(OS.WINDOWS)
    void contentCallbacksKeepIdentityTextAndOrder(boolean streaming, boolean identified) throws Exception {
        Path pidFile = temporary.resolve("child.pid");
        List<String> ids = new ArrayList<>();
        List<String> texts = new ArrayList<>();
        List<String> usageIds = new ArrayList<>();
        try {
            QwenCodeCli.simpleQuery("ordinary fixture prompt", options(streaming, identified, pidFile),
                    new AssistantContentSimpleConsumers() {
                        @Override
                        public void onText(Session session, TextAssistantContent content) {
                            ids.add(content.getMessageId());
                            texts.add(content.getText());
                        }

                        @Override
                        public void onUsage(Session session, AssistantUsage usage) {
                            usageIds.add(usage.getMessageId());
                        }
                    });

            assertEquals(List.of("first", "second", "third"), texts);
            assertEquals(streaming ? Collections.emptyList() : List.of("usage-1", "usage-2"), usageIds);
            List<String> expectedIds = !identified ? Collections.nCopies(3, null)
                    : streaming ? List.of(FIRST_ID, SECOND_ID, THIRD_ID) : List.of(FIRST_ID, FIRST_ID, SECOND_ID);
            assertEquals(expectedIds, ids);
        } finally {
            if (Files.exists(pidFile)) {
                ProcessHandle child = ProcessHandle.of(Long.parseLong(Files.readString(pidFile).trim())).orElse(null);
                if (child != null && child.isAlive()) {
                    child.destroyForcibly();
                    child.onExit().get(3, TimeUnit.SECONDS);
                }
            }
        }
    }

    @Test
    void missingUuidPreservesTheLegacyPartialMessageIdentifier() {
        SDKPartialAssistantMessage legacy = JSON.parseObject(
                "{\"type\":\"stream_event\",\"message_id\":\"legacy-id\"}", SDKPartialAssistantMessage.class);
        SDKPartialAssistantMessage missing = JSON.parseObject("{\"type\":\"stream_event\"}", SDKPartialAssistantMessage.class);

        assertEquals("legacy-id", legacy.getMessageId());
        assertNull(missing.getMessageId());
    }

    private TransportOptions options(boolean streaming, boolean identified, Path pidFile) throws Exception {
        String classpath = Paths.get(AssistantContentIdentityTest.class.getProtectionDomain().getCodeSource().getLocation().toURI())
                + File.pathSeparator + Paths.get(JSON.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        String java = Paths.get(System.getProperty("java.home"), "bin", "java").toString();
        Path script = temporary.resolve("content-identity-peer.sh");
        Files.write(script, ("#!/bin/sh\nexec " + quote(java) + " -cp " + quote(classpath) + " "
                + quote(ContentIdentityPeer.class.getName()) + " " + streaming + " " + identified + " " + quote(pidFile.toString()) + "\n")
                .getBytes(StandardCharsets.UTF_8));
        assertTrue(script.toFile().setExecutable(true));
        return new TransportOptions().setPathToQwenExecutable(script.toString()).setIncludePartialMessages(streaming)
                .setTurnTimeout(new Timeout(2L, TimeUnit.SECONDS));
    }

    private static String quote(String value) {
        return "'" + value.replace("'", "'\"'\"'") + "'";
    }

    public static final class ContentIdentityPeer {
        public static void main(String[] args) throws Exception {
            boolean streaming = Boolean.parseBoolean(args[0]);
            boolean identified = Boolean.parseBoolean(args[1]);
            Files.writeString(Paths.get(args[2]), Long.toString(ProcessHandle.current().pid()));
            BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            JSONObject request = JSON.parseObject(input.readLine());
            JSONObject initialized = JSON.parseObject("{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\","
                    + "\"response\":{\"subtype\":\"initialize\",\"capabilities\":{}}}}");
            initialized.getJSONObject("response").put("request_id", request.get("request_id"));
            System.out.println(initialized);
            JSON.parseObject(input.readLine());

            String[] ids = {FIRST_ID, SECOND_ID, THIRD_ID};
            String[] texts = {"first", "second", "third"};
            for (int index = 0; index < (streaming ? 3 : 2); index++) {
                JSONObject message;
                if (streaming) {
                    message = JSON.parseObject("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\","
                            + "\"index\":0,\"delta\":{\"type\":\"text_delta\"}}}");
                    message.getJSONObject("event").getJSONObject("delta").put("text", texts[index]);
                } else {
                    message = JSON.parseObject("{\"type\":\"assistant\",\"message\":{}}");
                    JSONObject body = message.getJSONObject("message");
                    body.put("id", "usage-" + (index + 1));
                    body.put("content", index == 0
                            ? List.of(textBlock("first"), textBlock("second")) : List.of(textBlock("third")));
                }
                if (identified) {
                    message.put("uuid", ids[index]);
                }
                System.out.println(message);
            }
            System.out.println("{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"done\"}");
            while (input.readLine() != null) {
                // Keep the process available until the query closes its transport.
            }
        }

        private static JSONObject textBlock(String text) {
            JSONObject block = new JSONObject();
            block.put("type", "text");
            block.put("text", text);
            return block;
        }
    }
}
