import Foundation

@main
enum ChatInitialScrollRegression {
    static func main() throws {
        let source = try String(contentsOfFile: "Sources/GrokDesk/Views.swift", encoding: .utf8)

        require(source.contains("VStack(alignment: .leading, spacing: 26)"),
                "the bounded recent-message window must be measured eagerly before applying its bottom anchor")
        require(!source.contains("LazyVStack(alignment: .leading, spacing: 26)"),
                "the transcript still uses lazy height estimation that can position the viewport in blank space")
        require(source.contains(".defaultScrollAnchor(isNearLatestMessage ? .bottom : .top)"),
                "the transcript must follow the latest message only while the viewport is already near the bottom")
        require(source.contains("private static let messagePageSize = 12"),
                "long chats must render a small, bounded initial message page")
        require(!source.contains("visibleMessageLimit = 80"),
                "switching chats must not eagerly render the old 80-message window")
        let conversationIdentityCount = source.components(separatedBy: ".id(model.selectedConversationID)").count - 1
        require(conversationIdentityCount >= 2,
                "switching conversations must recreate the transcript with its own initial scroll position")
        require(!source.contains("positionedConversationID"),
                "a failed initial-position task must never leave the entire transcript transparent")
        require(!source.contains(".padding(.horizontal, 34).padding(.top, 34).padding(.bottom, 150)"),
                "the transcript must not reserve a second composer-sized blank region at its bottom")
        require(!source.contains("scrollToLatest(proxy, animated: true)"),
                "streaming deltas must not enqueue overlapping scroll animations")
        require(source.contains("let haystack = [event.kind, event.title]"),
                "collapsed process groups must classify metadata without scanning event payloads")
        require(source.contains(".onChange(of: latestMessageSignal)"),
                "stream following must not compare a complete event-heavy message")

        print("Chat initial scroll regression passed")
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
    }
}
